import { assertIdentifier } from "../db/identifiers";

const KEY_LENGTH = 32;

export interface WorkerConfig {
  appSchema: string;
  engineSchema: string;
  replicaDbUrl?: string;
  retentionYears: number;
  noticeWindowHours: number;
  graphMaxDepth: number;
  outboxBatchSize: number;
  outboxLeaseSeconds: number;
  outboxMaxAttempts: number;
  outboxBaseBackoffMs: number;
  notificationLeaseSeconds: number;
  masterKey: Uint8Array;
  hmacKey: Uint8Array;
}

function parseInteger(name: string, rawValue: string | undefined, fallback: number, minimum: number): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }

  return parsed;
}

function decodeKey(rawValue: string, envName: string): Uint8Array {
  const value = rawValue.trim();
  if (value.length === 0) {
    throw new Error(`${envName} is required.`);
  }

  const normalizedHex = value.startsWith("hex:") ? value.slice(4) : value;
  if (/^[0-9a-fA-F]+$/.test(normalizedHex) && normalizedHex.length === KEY_LENGTH * 2) {
    return new Uint8Array(Buffer.from(normalizedHex, "hex"));
  }

  const normalizedBase64 = value.startsWith("base64:") ? value.slice(7) : value;
  const decoded = Buffer.from(normalizedBase64, "base64");
  if (decoded.length === KEY_LENGTH) {
    return new Uint8Array(decoded);
  }

  throw new Error(`${envName} must decode to exactly ${KEY_LENGTH} bytes. Supported formats: 64-char hex or base64.`);
}

/**
 * Layman Terms:
 * The Bouncer. When the worker tries to start up, the Bouncer checks its pockets. 
 * Did it bring the Master Key? Are the settings for the safes (the schemas) valid?
 * If the worker forgot its keys or brought the wrong ones, the Bouncer shuts the whole 
 * factory down immediately. It's better to stay closed than to operate with bad security.
 *
 * Technical Terms:
 * Validates and decodes environment variables synchronously at startup (Fail-Fast).
 * Enforces cryptographic constraints (32-byte keys, hex/base64 formats) and schema name 
 * validity, mitigating downstream data corruption or unauthorized state.
 */
export function readWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const appSchema = assertIdentifier(env.DPDP_APP_SCHEMA ?? "mock_app", "application schema name");
  const engineSchema = assertIdentifier(env.DPDP_ENGINE_SCHEMA ?? "dpdp_engine", "engine schema name");

  const masterKey = decodeKey(env.DPDP_MASTER_KEY ?? "", "DPDP_MASTER_KEY");
  const hmacKey = decodeKey(env.DPDP_HMAC_KEY ?? env.DPDP_MASTER_KEY ?? "", "DPDP_HMAC_KEY");

  return {
    appSchema,
    engineSchema,
    replicaDbUrl: env.DPDP_REPLICA_DATABASE_URL?.trim() || undefined,
    retentionYears: parseInteger("DPDP_RETENTION_YEARS", env.DPDP_RETENTION_YEARS, 5, 1),
    noticeWindowHours: parseInteger("DPDP_NOTICE_WINDOW_HOURS", env.DPDP_NOTICE_WINDOW_HOURS, 48, 1),
    graphMaxDepth: parseInteger("DPDP_GRAPH_MAX_DEPTH", env.DPDP_GRAPH_MAX_DEPTH, 32, 1),
    outboxBatchSize: parseInteger("DPDP_OUTBOX_BATCH_SIZE", env.DPDP_OUTBOX_BATCH_SIZE, 10, 1),
    outboxLeaseSeconds: parseInteger("DPDP_OUTBOX_LEASE_SECONDS", env.DPDP_OUTBOX_LEASE_SECONDS, 60, 1),
    outboxMaxAttempts: parseInteger("DPDP_OUTBOX_MAX_ATTEMPTS", env.DPDP_OUTBOX_MAX_ATTEMPTS, 10, 1),
    outboxBaseBackoffMs: parseInteger("DPDP_OUTBOX_BASE_BACKOFF_MS", env.DPDP_OUTBOX_BASE_BACKOFF_MS, 1000, 1),
    notificationLeaseSeconds: parseInteger("DPDP_NOTIFICATION_LEASE_SECONDS", env.DPDP_NOTIFICATION_LEASE_SECONDS, 120, 1),
    masterKey,
    hmacKey,
  };
}
