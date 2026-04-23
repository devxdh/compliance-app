import type postgres from "postgres";
import { fail } from "../../errors";
import { sha256Hex } from "../../utils/digest";
import { canonicalJsonStringify } from "../../utils/json";
import type { OutboxRow, OutboxTailRow, SqlExecutor } from "./types";

/**
 * Enqueues a tamper-evident outbox event inside the current transaction scope.
 *
 * The function is idempotent by `idempotency_key` and serializes chain head updates with an
 * advisory transaction lock, keeping hash-chain append complexity O(1).
 *
 * @param sql - Postgres pool or transaction.
 * @param engineSchema - Worker engine schema.
 * @param userHash - Subject hash associated with the event.
 * @param eventType - Outbox event type.
 * @param payload - JSON-serializable event payload.
 * @param idempotencyKey - Global idempotency key for replay safety.
 * @param now - Event creation timestamp.
 * @returns Existing or newly inserted outbox row.
 * @throws {WorkerError} When payload is non-serializable or insert invariants are violated.
 */
export async function enqueueOutboxEvent(
  sql: SqlExecutor,
  engineSchema: string,
  userHash: string,
  eventType: string,
  payload: unknown,
  idempotencyKey: string,
  now: Date
): Promise<OutboxRow> {
  const jsonPayload = payload as postgres.JSONValue;
  let serializedPayload: string;
  try {
    serializedPayload = canonicalJsonStringify(jsonPayload);
  } catch {
    fail({
      code: "DPDP_OUTBOX_PAYLOAD_INVALID",
      title: "Invalid outbox payload",
      detail: "Outbox payload must be JSON-serializable.",
      category: "validation",
      retryable: false,
    });
  }

  const [existing] = await sql<OutboxRow[]>`
    SELECT *
    FROM ${sql(engineSchema)}.outbox
    WHERE idempotency_key = ${idempotencyKey}
    LIMIT 1
  `;

  if (existing) {
    return existing;
  }

  await sql`
    SELECT pg_advisory_xact_lock(hashtext(${`${engineSchema}.outbox.hash_chain`}))
  `;

  const [replayed] = await sql<OutboxRow[]>`
    SELECT *
    FROM ${sql(engineSchema)}.outbox
    WHERE idempotency_key = ${idempotencyKey}
    LIMIT 1
  `;

  if (replayed) {
    return replayed;
  }

  const [tail] = await sql<OutboxTailRow[]>`
    SELECT current_hash
    FROM ${sql(engineSchema)}.outbox
    WHERE current_hash IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;

  const previousHash = tail?.current_hash ?? "GENESIS";
  const currentHash = await sha256Hex(
    `${previousHash}${serializedPayload}${idempotencyKey}`
  );

  const [inserted] = await sql<OutboxRow[]>`
    INSERT INTO ${sql(engineSchema)}.outbox (
      idempotency_key,
      user_uuid_hash,
      event_type,
      payload,
      previous_hash,
      current_hash,
      status,
      attempt_count,
      next_attempt_at,
      created_at,
      updated_at
    )
    VALUES (
      ${idempotencyKey},
      ${userHash},
      ${eventType},
      ${sql.json(jsonPayload)},
      ${previousHash},
      ${currentHash},
      'pending',
      0,
      ${now},
      ${now},
      ${now}
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING *
  `;

  if (inserted) {
    return inserted;
  }

  const [stored] = await sql<OutboxRow[]>`
    SELECT *
    FROM ${sql(engineSchema)}.outbox
    WHERE idempotency_key = ${idempotencyKey}
    LIMIT 1
  `;

  if (!stored) {
    fail({
      code: "DPDP_OUTBOX_INSERT_INVARIANT_BROKEN",
      title: "Outbox insert invariant broken",
      detail: `Outbox insert for ${idempotencyKey} completed without returning a row.`,
      category: "database",
      retryable: false,
      fatal: true,
      context: { idempotencyKey },
    });
  }

  return stored;
}
