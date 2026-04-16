import postgres from "postgres";
import { generateHMAC } from "../crypto/hmac";
import { assertIdentifier, quoteQualifiedIdentifier } from "../db/identifiers";
import type { WorkerSchemas, WorkerSecrets } from "./contracts";

export const DEFAULT_APP_SCHEMA = "mock_app";
export const DEFAULT_ENGINE_SCHEMA = "dpdp_engine";
export const DEFAULT_NOTICE_WINDOW_HOURS = 48;
export const DEFAULT_RETENTION_YEARS = 5;
export const DEFAULT_GRAPH_MAX_DEPTH = 32;
export const DESTROYED_PII_SENTINEL = Object.freeze({ v: 1, destroyed: true });

export interface VaultRecord {
  user_uuid_hash: string;
  root_schema: string;
  root_table: string;
  root_id: string;
  pseudonym: string;
  encrypted_pii: { v?: number; data?: string; destroyed?: boolean };
  salt: string;
  dependency_count: number;
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

export type SqlExecutor = postgres.Sql | postgres.TransactionSql;

export function resolveSchemas(input: WorkerSchemas = {}) {
  return {
    appSchema: assertIdentifier(input.appSchema ?? DEFAULT_APP_SCHEMA, "application schema name"),
    engineSchema: assertIdentifier(input.engineSchema ?? DEFAULT_ENGINE_SCHEMA, "engine schema name"),
  };
}

export function resolveNoticeWindowHours(hours?: number): number {
  if (hours === undefined) {
    return DEFAULT_NOTICE_WINDOW_HOURS;
  }

  if (!Number.isInteger(hours) || hours < 1) {
    throw new Error("noticeWindowHours must be an integer greater than 0.");
  }

  return hours;
}

export function resolveRetentionYears(years?: number): number {
  if (years === undefined) {
    return DEFAULT_RETENTION_YEARS;
  }

  if (!Number.isInteger(years) || years < 1) {
    throw new Error("retentionYears must be an integer greater than 0.");
  }

  return years;
}

export function resolveGraphMaxDepth(depth?: number): number {
  if (depth === undefined) {
    return DEFAULT_GRAPH_MAX_DEPTH;
  }

  if (!Number.isInteger(depth) || depth < 1) {
    throw new Error("graphMaxDepth must be an integer greater than 0.");
  }

  return depth;
}

export function assertWorkerSecrets(secrets: WorkerSecrets): { kek: Uint8Array; hmacKey: Uint8Array } {
  if (secrets.kek.length !== 32) {
    throw new Error(`Invalid KEK length. Expected 32 bytes, got ${secrets.kek.length}.`);
  }

  const hmacKey = secrets.hmacKey ?? secrets.kek;
  if (hmacKey.length === 0) {
    throw new Error("HMAC key must not be empty.");
  }

  return {
    kek: secrets.kek,
    hmacKey,
  };
}

export function calculateRetentionWindow(now: Date, retentionYears: number, noticeWindowHours: number) {
  const retentionExpiry = new Date(now);
  retentionExpiry.setUTCFullYear(retentionExpiry.getUTCFullYear() + retentionYears);

  const notificationDueAt = new Date(retentionExpiry.getTime() - noticeWindowHours * 60 * 60 * 1000);
  if (notificationDueAt <= now) {
    throw new Error("noticeWindowHours is too large for the configured retentionYears.");
  }

  return {
    retentionExpiry,
    notificationDueAt,
  };
}

export async function createUserHash(userId: number, appSchema: string, hmacKey: Uint8Array): Promise<string> {
  return generateHMAC(`${appSchema}:users:${userId}`, Buffer.from(hmacKey).toString("base64"));
}

export async function createPseudonym(userId: number, email: string, salt: string, hmacKey: Uint8Array): Promise<string> {
  const digest = await generateHMAC(`${userId}:${email}`, `${salt}:${Buffer.from(hmacKey).toString("base64")}`);
  return `dpdp_${digest.slice(0, 24)}@dpdp.invalid`;
}

export function buildUserLookupSql(engineSchema: string): string {
  return `SELECT * FROM ${quoteQualifiedIdentifier(engineSchema, "pii_vault")} WHERE root_schema = $1 AND root_table = 'users' AND root_id = $2`;
}

export async function getVaultRecordByUserId(
  sql: SqlExecutor,
  engineSchema: string,
  appSchema: string,
  userId: number
): Promise<VaultRecord | null> {
  const rows = await sql.unsafe<VaultRecord[]>(buildUserLookupSql(engineSchema), [appSchema, userId.toString()]);
  return rows[0] ?? null;
}

export async function enqueueOutboxEvent(
  sql: SqlExecutor,
  engineSchema: string,
  userHash: string,
  eventType: string,
  payload: unknown,
  idempotencyKey: string,
  now: Date
): Promise<OutboxRow> {
  const [inserted] = await sql<OutboxRow[]>`
    INSERT INTO ${sql(engineSchema)}.outbox (
      idempotency_key,
      user_uuid_hash,
      event_type,
      payload,
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
      ${sql.json(payload as postgres.JSONValue)},
      'pending',
      0,
      ${now},
      ${now},
      ${now}
    )
    ON CONFLICT (idempotency_key) DO UPDATE
      SET payload = EXCLUDED.payload,
          updated_at = EXCLUDED.updated_at
    RETURNING *
  `;

  return inserted!;
}

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
