/**
 * Transactional outbox relay with lease-based claiming and retry/dead-letter handling.
 *
 * Network calls are always executed outside the claim transaction to avoid long-lived row locks.
 */

import postgres from "postgres";
import { assertIdentifier } from "../db/identifiers";
import type { OutboxRow } from "../engine/support";
import { asWorkerError, fail, workerError } from "../errors";
import { getLogger, logError } from "../observability/logger";

export interface OutboxEvent extends OutboxRow {}

/**
 * Runtime controls for outbox claim and retry behavior.
 */
export interface ProcessOutboxOptions {
  engineSchema?: string;
  batchSize?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  now?: Date;
}

/**
 * Aggregated counters from one outbox processing cycle.
 */
export interface ProcessOutboxResult {
  claimed: number;
  processed: number;
  failed: number;
  deadLettered: number;
}

/**
 * HTTP dispatcher configuration for pushing outbox events to the Control Plane.
 */
export interface FetchDispatcherOptions {
  url: string;
  token?: string;
  clientId?: string;
  timeoutMs?: number;
}

interface ControlPlaneOutboxPayload {
  request_id?: string | null;
  subject_opaque_id?: string | null;
  event_timestamp?: string | null;
  [key: string]: unknown;
}

const DEFAULT_ENGINE_SCHEMA = "dpdp_engine";
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const logger = getLogger({ component: "outbox" });

function resolvePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < 1) {
    fail({
      code: "DPDP_OUTBOX_OPTION_INVALID",
      title: "Invalid outbox option",
      detail: `${label} must be an integer greater than 0.`,
      category: "validation",
      retryable: false,
      context: { label },
    });
  }

  return value;
}

/**
 * No-op dispatcher used by tests/local execution when no HTTP transport is injected.
 *
 * @param event - Outbox event to "send".
 * @returns Always `true` after logging.
 */
export async function sendToAPI(event: OutboxEvent): Promise<boolean> {
  logger.info({ eventId: event.id, eventType: event.event_type }, "Outbox event synced");
  return true;
}

/**
 * Creates an HTTP dispatcher that publishes worker outbox events to the Control Plane.
 *
 * @param options - Endpoint URL, auth headers, and timeout configuration.
 * @returns Dispatcher function compatible with `processOutbox`.
 */
export function createFetchDispatcher(options: FetchDispatcherOptions) {
  const timeoutMs = options.timeoutMs ?? 10_000;

  function buildControlPlaneRequestBody(event: OutboxEvent) {
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      fail({
        code: "DPDP_OUTBOX_PAYLOAD_INVALID",
        title: "Invalid outbox payload",
        detail: `Outbox payload for event ${event.id} must be an object.`,
        category: "integrity",
        retryable: false,
        fatal: true,
        context: { eventId: event.id },
      });
    }

    const payload = event.payload as ControlPlaneOutboxPayload;
    if (!payload.request_id || !payload.subject_opaque_id || !payload.event_timestamp) {
      fail({
        code: "DPDP_OUTBOX_PROTOCOL_REJECTED",
        title: "Outbox payload missing control-plane envelope",
        detail: `Outbox event ${event.id} is missing request_id, subject_opaque_id, or event_timestamp.`,
        category: "integrity",
        retryable: false,
        fatal: true,
        context: { eventId: event.id },
      });
    }

    return {
      idempotency_key: event.idempotency_key,
      request_id: payload.request_id,
      subject_opaque_id: payload.subject_opaque_id,
      event_type: event.event_type,
      payload,
      previous_hash: event.previous_hash,
      current_hash: event.current_hash,
      event_timestamp: payload.event_timestamp,
    };
  }

  return async function dispatch(event: OutboxEvent): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const body = buildControlPlaneRequestBody(event);

    try {
      const response = await fetch(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.clientId ? { "x-client-id": options.clientId } : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw workerError({
          code:
            response.status === 401 || response.status === 403
              ? "DPDP_OUTBOX_AUTH_REJECTED"
              : response.status === 429 || response.status >= 500
                ? "DPDP_OUTBOX_DELIVERY_FAILED"
                : "DPDP_OUTBOX_PROTOCOL_REJECTED",
          title:
            response.status === 401 || response.status === 403
              ? "Control Plane authentication rejected outbox event"
              : "Control Plane rejected outbox event",
          detail: `Brain API responded with HTTP ${response.status}.`,
          category:
            response.status === 401 || response.status === 403
              ? "configuration"
              : response.status === 429 || response.status >= 500
                ? "network"
                : "external",
          retryable: response.status >= 500 || response.status === 429,
          fatal: response.status < 500 && response.status !== 429,
          context: {
            status: response.status,
            url: options.url,
          },
        });
      }

      return true;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Computes exponential retry delay capped at five minutes.
 *
 * @param attemptNumber - 1-based attempt count.
 * @param baseBackoffMs - Initial backoff duration in milliseconds.
 * @returns Retry delay in milliseconds.
 */
export function calculateRetryDelayMs(attemptNumber: number, baseBackoffMs: number = DEFAULT_BASE_BACKOFF_MS): number {
  return Math.min(baseBackoffMs * 2 ** Math.max(0, attemptNumber - 1), 5 * 60 * 1000);
}

async function claimOutboxBatch(
  sql: postgres.Sql,
  engineSchema: string,
  batchSize: number,
  leaseSeconds: number,
  now: Date
): Promise<{ leaseToken: string; events: OutboxEvent[] }> {
  return sql.begin(async (tx) => {
    const leaseToken = globalThis.crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);

    const events = await tx<OutboxEvent[]>`
      SELECT *
      FROM ${tx(engineSchema)}.outbox
      WHERE status IN ('pending', 'leased')
        AND next_attempt_at <= ${now}
        AND (status = 'pending' OR lease_expires_at IS NULL OR lease_expires_at <= ${now})
      ORDER BY created_at ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;

    for (const event of events) {
      await tx`
        UPDATE ${tx(engineSchema)}.outbox
        SET status = 'leased',
            lease_token = ${leaseToken},
            lease_expires_at = ${leaseExpiresAt},
            updated_at = ${now}
        WHERE id = ${event.id}
      `;

      event.status = "leased";
      event.lease_token = leaseToken;
      event.lease_expires_at = leaseExpiresAt;
      event.updated_at = now;
    }

    return {
      leaseToken,
      events,
    };
  });
}

async function markOutboxEventProcessed(
  sql: postgres.Sql,
  engineSchema: string,
  eventId: string,
  leaseToken: string,
  now: Date
) {
  const updated = await sql`
    UPDATE ${sql(engineSchema)}.outbox
    SET status = 'processed',
        processed_at = ${now},
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error = NULL,
        updated_at = ${now}
    WHERE id = ${eventId}
      AND lease_token = ${leaseToken}
      AND status = 'leased'
    RETURNING id
  `;

  if (updated.length === 0) {
    fail({
      code: "DPDP_OUTBOX_LEASE_LOST",
      title: "Outbox lease lost",
      detail: `Outbox lease for event ${eventId} was lost before it could be marked processed.`,
      category: "concurrency",
      retryable: true,
      context: { eventId },
    });
  }
}

async function markOutboxEventFailed(
  sql: postgres.Sql,
  engineSchema: string,
  event: OutboxEvent,
  leaseToken: string,
  now: Date,
  maxAttempts: number,
  baseBackoffMs: number,
  error: unknown
): Promise<"pending" | "dead_letter"> {
  const nextAttemptCount = event.attempt_count + 1;
  const deadLetter = nextAttemptCount >= maxAttempts;
  const nextAttemptAt = new Date(now.getTime() + calculateRetryDelayMs(nextAttemptCount, baseBackoffMs));
  const errorMessage = error instanceof Error ? error.message : String(error);

  const updated = await sql`
    UPDATE ${sql(engineSchema)}.outbox
    SET status = ${deadLetter ? "dead_letter" : "pending"},
        attempt_count = ${nextAttemptCount},
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = ${deadLetter ? now : nextAttemptAt},
        last_error = ${errorMessage.slice(0, 1024)},
        updated_at = ${now}
    WHERE id = ${event.id}
      AND lease_token = ${leaseToken}
      AND status = 'leased'
    RETURNING id
  `;

  if (updated.length === 0) {
    fail({
      code: "DPDP_OUTBOX_LEASE_LOST",
      title: "Outbox lease lost",
      detail: `Outbox lease for event ${event.id} was lost before it could be retried.`,
      category: "concurrency",
      retryable: true,
      context: { eventId: event.id },
    });
  }

  return deadLetter ? "dead_letter" : "pending";
}

async function releaseOutboxLease(
  sql: postgres.Sql,
  engineSchema: string,
  eventId: string,
  leaseToken: string,
  now: Date,
  error: unknown
) {
  const normalized = asWorkerError(error);

  const updated = await sql`
    UPDATE ${sql(engineSchema)}.outbox
    SET status = 'pending',
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = ${now},
        last_error = ${normalized.detail.slice(0, 1024)},
        updated_at = ${now}
    WHERE id = ${eventId}
      AND lease_token = ${leaseToken}
      AND status = 'leased'
    RETURNING id
  `;

  if (updated.length === 0) {
    fail({
      code: "DPDP_OUTBOX_LEASE_LOST",
      title: "Outbox lease lost",
      detail: `Outbox lease for event ${eventId} was lost before it could be released.`,
      category: "concurrency",
      retryable: true,
      context: { eventId },
    });
  }
}

/**
 * Claims due outbox events, dispatches them, and applies processed/retry/dead-letter state transitions.
 *
 * Fatal delivery failures are rethrown after lease release so the worker loop can fail closed.
 *
 * @param sql - Postgres pool owning the outbox table.
 * @param syncFn - Event delivery function (usually HTTP dispatcher).
 * @param options - Lease and retry tuning values.
 * @returns Aggregate processing counters for the claimed batch.
 * @throws {WorkerError} On fatal protocol/configuration errors or lease invariants.
 */
export async function processOutbox(
  sql: postgres.Sql,
  syncFn: (event: OutboxEvent) => Promise<boolean> = sendToAPI,
  options: ProcessOutboxOptions = {}
): Promise<ProcessOutboxResult> {
  const engineSchema = assertIdentifier(options.engineSchema ?? DEFAULT_ENGINE_SCHEMA, "engine schema name");
  const batchSize = resolvePositiveInteger(options.batchSize, DEFAULT_BATCH_SIZE, "batchSize");
  const leaseSeconds = resolvePositiveInteger(options.leaseSeconds, DEFAULT_LEASE_SECONDS, "leaseSeconds");
  const maxAttempts = resolvePositiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, "maxAttempts");
  const baseBackoffMs = resolvePositiveInteger(options.baseBackoffMs, DEFAULT_BASE_BACKOFF_MS, "baseBackoffMs");
  const clock = () => (options.now ? new Date(options.now) : new Date());
  const now = clock();

  const { leaseToken, events } = await claimOutboxBatch(sql, engineSchema, batchSize, leaseSeconds, now);

  const result: ProcessOutboxResult = {
    claimed: events.length,
    processed: 0,
    failed: 0,
    deadLettered: 0,
  };

  for (const event of events) {
    try {
      const delivered = await syncFn(event);
      if (!delivered) {
        throw workerError({
          code: "DPDP_OUTBOX_DELIVERY_RESULT_INVALID",
          title: "Outbox dispatcher returned an invalid result",
          detail: `Dispatcher returned a falsy delivery result for event ${event.id}.`,
          category: "network",
          retryable: true,
          context: { eventId: event.id },
        });
      }

      await markOutboxEventProcessed(sql, engineSchema, event.id, leaseToken, clock());
      result.processed += 1;
    } catch (error) {
      const normalized = logError(logger, error, "Failed to sync outbox event", {
        eventId: event.id,
        eventType: event.event_type,
      });

      if (normalized.fatal) {
        await releaseOutboxLease(sql, engineSchema, event.id, leaseToken, clock(), normalized);
        throw normalized;
      }

      const failureState = await markOutboxEventFailed(
        sql,
        engineSchema,
        event,
        leaseToken,
        clock(),
        maxAttempts,
        baseBackoffMs,
        error
      );

      result.failed += 1;
      if (failureState === "dead_letter") {
        result.deadLettered += 1;
      }
    }
  }

  return result;
}
