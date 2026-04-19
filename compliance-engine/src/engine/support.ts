import postgres from "postgres";
import { generateHMAC } from "../crypto/hmac";
import { assertIdentifier, quoteQualifiedIdentifier } from "../db/identifiers";
import type { WorkerSchemas, WorkerSecrets } from "./contracts";
import { sha256Hex } from "../utils/digest";
import { fail } from "../errors";

export const DEFAULT_APP_SCHEMA = "mock_app";
export const DEFAULT_ENGINE_SCHEMA = "dpdp_engine";
export const DEFAULT_NOTICE_WINDOW_HOURS = 48;
export const DEFAULT_RETENTION_YEARS = 0;
export const DEFAULT_GRAPH_MAX_DEPTH = 32;
export const DESTROYED_PII_SENTINEL = Object.freeze({ v: 1, destroyed: true });

/**
 * Durable record shape stored in `${engineSchema}.pii_vault`.
 *
 * The row is treated as write-once for legal metadata and mutable for state-machine timestamps
 * (`notification_sent_at`, `shredded_at`, lease fields).
 */
export interface VaultRecord {
  user_uuid_hash: string;
  request_id: string | null;
  tenant_id: string;
  root_schema: string;
  root_table: string;
  root_id: string;
  pseudonym: string;
  encrypted_pii: { v?: number; data?: string; destroyed?: boolean };
  salt: string;
  dependency_count: number;
  trigger_source: string | null;
  legal_framework: string | null;
  actor_opaque_id: string | null;
  applied_rule_name: string | null;
  retention_expiry: Date;
  notification_due_at: Date;
  notification_sent_at: Date | null;
  notification_lock_id: string | null;
  notification_lock_expires_at: Date | null;
  shredded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface OutboxRow {
  id: string;
  idempotency_key: string;
  user_uuid_hash: string;
  event_type: string;
  payload: unknown;
  previous_hash: string;
  current_hash: string;
  status: "pending" | "leased" | "processed" | "dead_letter";
  attempt_count: number;
  lease_token: string | null;
  lease_expires_at: Date | null;
  next_attempt_at: Date;
  processed_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * SQL executor accepted by shared helpers.
 *
 * Supports both pool-level operations and transactional execution.
 */
export type SqlExecutor = postgres.Sql | postgres.TransactionSql;

interface OutboxTailRow {
  current_hash: string | null;
}

/**
 * Resolves and validates application/engine schema identifiers used by worker operations.
 *
 * @param input - Optional schema overrides from operation options.
 * @returns Canonical schema names safe for dynamic identifier interpolation.
 * @throws {WorkerError} When any schema name fails identifier validation.
 */
export function resolveSchemas(input: WorkerSchemas = {}) {
  return {
    appSchema: assertIdentifier(input.appSchema ?? DEFAULT_APP_SCHEMA, "application schema name"),
    engineSchema: assertIdentifier(input.engineSchema ?? DEFAULT_ENGINE_SCHEMA, "engine schema name"),
  };
}

/**
 * Normalizes notice window configuration while enforcing the legal minimum of one hour.
 *
 * @param hours - Optional notice window in hours.
 * @returns Validated notice window value.
 * @throws {WorkerError} When `hours` is non-integer or less than 1.
 */
export function resolveNoticeWindowHours(hours?: number): number {
  if (hours === undefined) {
    return DEFAULT_NOTICE_WINDOW_HOURS;
  }

  if (!Number.isInteger(hours) || hours < 1) {
    fail({
      code: "DPDP_NOTICE_WINDOW_INVALID",
      title: "Invalid notice window",
      detail: "noticeWindowHours must be an integer greater than 0.",
      category: "validation",
      retryable: false,
    });
  }

  return hours;
}

/**
 * Normalizes retention years with strict non-negative validation.
 *
 * @param years - Optional retention duration in years.
 * @returns Validated retention duration.
 * @throws {WorkerError} When `years` is non-integer or negative.
 */
export function resolveRetentionYears(years?: number): number {
  if (years === undefined) {
    return DEFAULT_RETENTION_YEARS;
  }

  if (!Number.isInteger(years) || years < 0) {
    fail({
      code: "DPDP_RETENTION_YEARS_INVALID",
      title: "Invalid retention period",
      detail: "retentionYears must be an integer greater than or equal to 0.",
      category: "validation",
      retryable: false,
    });
  }

  return years;
}

/**
 * Normalizes dependency graph traversal depth and enforces a positive integer bound.
 *
 * @param depth - Optional graph traversal depth.
 * @returns Validated depth used by graph discovery.
 * @throws {WorkerError} When `depth` is non-integer or less than 1.
 */
export function resolveGraphMaxDepth(depth?: number): number {
  if (depth === undefined) {
    return DEFAULT_GRAPH_MAX_DEPTH;
  }

  if (!Number.isInteger(depth) || depth < 1) {
    fail({
      code: "DPDP_GRAPH_MAX_DEPTH_INVALID",
      title: "Invalid graph max depth",
      detail: "graphMaxDepth must be an integer greater than 0.",
      category: "validation",
      retryable: false,
    });
  }

  return depth;
}

/**
 * Validates worker cryptographic material before any vaulting operation begins.
 *
 * `hmacKey` falls back to `kek` when not provided, preserving deterministic pseudonymization.
 *
 * @param secrets - Worker key material loaded from config/env.
 * @returns Normalized key pair (`kek`, `hmacKey`) safe for downstream crypto helpers.
 * @throws {WorkerError} When KEK length is not 32 bytes or HMAC key is empty.
 */
export function assertWorkerSecrets(secrets: WorkerSecrets): { kek: Uint8Array; hmacKey: Uint8Array } {
  if (secrets.kek.length !== 32) {
    fail({
      code: "DPDP_KEK_INVALID_LENGTH",
      title: "Invalid KEK length",
      detail: `Invalid KEK length. Expected 32 bytes, got ${secrets.kek.length}.`,
      category: "configuration",
      retryable: false,
      fatal: true,
    });
  }

  const hmacKey = secrets.hmacKey ?? secrets.kek;
  if (hmacKey.length === 0) {
    fail({
      code: "DPDP_HMAC_KEY_EMPTY",
      title: "Invalid HMAC key",
      detail: "HMAC key must not be empty.",
      category: "configuration",
      retryable: false,
      fatal: true,
    });
  }

  return {
    kek: secrets.kek,
    hmacKey,
  };
}

/**
 * Computes retention and pre-erasure notice boundaries using UTC arithmetic.
 *
 * @param now - Evaluation anchor timestamp.
 * @param retentionYears - Legal retention duration in years.
 * @param noticeWindowHours - Notice lead-time in hours before retention expiry.
 * @returns `retentionExpiry` and `notificationDueAt` timestamps.
 */
export function calculateRetentionWindow(now: Date, retentionYears: number, noticeWindowHours: number) {
  const retentionExpiry = new Date(now);
  retentionExpiry.setUTCFullYear(retentionExpiry.getUTCFullYear() + retentionYears);

  const notificationDueAt = new Date(
    Math.max(now.getTime(), retentionExpiry.getTime() - noticeWindowHours * 60 * 60 * 1000)
  );

  return {
    retentionExpiry,
    notificationDueAt,
  };
}

/**
 * Produces a deterministic subject hash used as the worker's irreversible lookup key.
 *
 * @param rootId - Subject identifier in source schema.
 * @param appSchema - Source schema name.
 * @param rootTable - Source root table name.
 * @param hmacKey - HMAC key bytes.
 * @param tenantId - Optional tenant discriminator.
 * @returns Stable HMAC-SHA256 hex digest.
 */
export async function createUserHash(
  rootId: string | number,
  appSchema: string,
  rootTable: string,
  hmacKey: Uint8Array,
  tenantId?: string
): Promise<string> {
  return generateHMAC(
    `${appSchema}:${rootTable}:${tenantId ?? ""}:${rootId}`,
    Buffer.from(hmacKey).toString("base64")
  );
}

/**
 * Derives an irreversible synthetic email for downstream systems that still require an address-shaped value.
 *
 * @param userId - Source subject identifier.
 * @param email - Original email value from root payload.
 * @param salt - Per-row salt stored in vault metadata.
 * @param hmacKey - HMAC key bytes.
 * @returns Pseudonymous `dpdp_...@dpdp.invalid` address.
 */
export async function createPseudonym(
  userId: string | number,
  email: string,
  salt: string,
  hmacKey: Uint8Array
): Promise<string> {
  const digest = await generateHMAC(`${userId}:${email}`, `${salt}:${Buffer.from(hmacKey).toString("base64")}`);
  return `dpdp_${digest.slice(0, 24)}@dpdp.invalid`;
}

/**
 * Builds the parameterized SQL statement used by `getVaultRecordByUserId`.
 *
 * @param engineSchema - Worker engine schema.
 * @returns SQL text with positional parameters for root identity lookup.
 */
export function buildUserLookupSql(engineSchema: string): string {
  return `SELECT * FROM ${quoteQualifiedIdentifier(engineSchema, "pii_vault")} WHERE root_schema = $1 AND root_table = $2 AND root_id = $3 AND tenant_id = $4`;
}

/**
 * Fetches a vault row by root identity tuple.
 *
 * Lookup uses `(root_schema, root_table, root_id, tenant_id)` to avoid cross-tenant collisions.
 *
 * @param sql - Postgres pool or transaction.
 * @param engineSchema - Worker engine schema.
 * @param appSchema - Source application schema.
 * @param userId - Source root identifier.
 * @param rootTable - Source root table name.
 * @param tenantId - Optional tenant discriminator.
 * @returns Matching vault row or `null` when not yet vaulted.
 */
export async function getVaultRecordByUserId(
  sql: SqlExecutor,
  engineSchema: string,
  appSchema: string,
  userId: string | number,
  rootTable: string = "users",
  tenantId?: string
): Promise<VaultRecord | null> {
  const rows = await sql.unsafe<VaultRecord[]>(buildUserLookupSql(engineSchema), [
    appSchema,
    rootTable,
    userId.toString(),
    tenantId ?? "",
  ]);
  return rows[0] ?? null;
}

/**
 * Enqueues a tamper-evident outbox event inside the current transaction scope.
 *
 * The function is idempotent by `idempotency_key` and serializes chain head updates with an advisory
 * transaction lock, keeping hash-chain append complexity O(1).
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
  const serializedPayload = JSON.stringify(jsonPayload);
  if (serializedPayload === undefined) {
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
  const currentHash = await sha256Hex(`${previousHash}${serializedPayload}${idempotencyKey}`);

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

/**
 * Replaces vaulted ciphertext with a non-PII sentinel and marks the vault as shredded.
 *
 * @param sql - Postgres pool or transaction.
 * @param engineSchema - Worker engine schema.
 * @param userHash - Subject hash key in `pii_vault`.
 * @param shreddedAt - Timestamp to persist as `shredded_at`.
 * @returns Promise that resolves when the vault row has been updated.
 */
export async function markVaultDestroyed(
  sql: SqlExecutor,
  engineSchema: string,
  userHash: string,
  shreddedAt: Date
) {
  await sql`
    UPDATE ${sql(engineSchema)}.pii_vault
    SET encrypted_pii = ${sql.json(DESTROYED_PII_SENTINEL)},
        shredded_at = ${shreddedAt},
        updated_at = ${shreddedAt}
    WHERE user_uuid_hash = ${userHash}
  `;
}
