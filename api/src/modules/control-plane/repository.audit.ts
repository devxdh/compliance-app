import type {
  AuditLedgerRow,
  InsertAuditLedgerEventInput,
  RepositoryContext,
} from "./repository.types";

/**
 * Reads the latest WORM hash pointer for a client in O(1) using the sequence index.
 *
 * @param context - Repository SQL context.
 * @param clientId - Worker client id.
 * @returns Current chain head hash or `null` for genesis state.
 */
export async function getLatestAuditHash(
  context: RepositoryContext,
  clientId: string
): Promise<string | null> {
  const [row] = await context.sql<{ current_hash: string }[]>`
    SELECT current_hash
    FROM ${context.sql(context.schema)}.audit_ledger
    WHERE client_id = ${clientId}
    ORDER BY ledger_seq DESC
    LIMIT 1
  `;
  return row?.current_hash ?? null;
}

/**
 * Appends one audit ledger event with idempotent conflict handling.
 *
 * @param context - Repository SQL context.
 * @param input - Event envelope and chain hashes.
 * @returns `true` when inserted, `false` when conflict indicates replay.
 */
export async function insertAuditLedgerEvent(
  context: RepositoryContext,
  input: InsertAuditLedgerEventInput
): Promise<boolean> {
  const rows = await context.sql<{ id: string }[]>`
    INSERT INTO ${context.sql(context.schema)}.audit_ledger (
      client_id,
      worker_idempotency_key,
      event_type,
      payload,
      previous_hash,
      current_hash,
      created_at
    ) VALUES (
      ${input.clientId},
      ${input.idempotencyKey},
      ${input.eventType},
      ${context.sql.json(input.payload as import("postgres").JSONValue)},
      ${input.previousHash},
      ${input.currentHash},
      ${input.now}
    )
    ON CONFLICT (worker_idempotency_key) DO NOTHING
    RETURNING id
  `;

  return rows.length > 0;
}

/**
 * Fetches a previously ingested audit event by its global idempotency key.
 *
 * @param context - Repository SQL context.
 * @param idempotencyKey - Worker idempotency key.
 * @returns Matching audit event or `null`.
 */
export async function getAuditEventByIdempotencyKey(
  context: RepositoryContext,
  idempotencyKey: string
): Promise<AuditLedgerRow | null> {
  const [row] = await context.sql<AuditLedgerRow[]>`
    SELECT *
    FROM ${context.sql(context.schema)}.audit_ledger
    WHERE worker_idempotency_key = ${idempotencyKey}
  `;
  return row ?? null;
}
