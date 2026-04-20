/**
 * Transactional outbox relay with lease-based claiming and retry/dead-letter handling.
 *
 * Network calls are always executed outside the claim transaction to avoid long-lived row locks.
 */

import postgres from "postgres";
import { assertIdentifier } from "../db/identifiers";
import { logError, getLogger } from "../observability/logger";
import { sendToAPI } from "./outbox.dispatcher";
import {
  claimOutboxBatch,
  markOutboxEventFailed,
  markOutboxEventProcessed,
  releaseOutboxLease,
} from "./outbox.store";
import {
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_ENGINE_SCHEMA,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_MAX_ATTEMPTS,
  resolvePositiveInteger,
  type OutboxEvent,
  type ProcessOutboxOptions,
  type ProcessOutboxResult,
  calculateRetryDelayMs,
} from "./outbox.shared";
import { workerError } from "../errors";

export {
  calculateRetryDelayMs,
  type FetchDispatcherOptions,
  type OutboxEvent,
  type ProcessOutboxOptions,
  type ProcessOutboxResult,
} from "./outbox.shared";
export { createFetchDispatcher, sendToAPI } from "./outbox.dispatcher";

const logger = getLogger({ component: "outbox" });

/**
 * Claims due outbox events, dispatches them, and applies processed/retry/dead-letter state transitions.
 *
 * Fatal delivery failures are rethrown after lease release so the worker loop can fail closed.
 *
 * @param sql - Postgres pool owning the outbox table.
 * @param syncFn - Event delivery function, usually an HTTP dispatcher.
 * @param options - Lease and retry tuning values.
 * @returns Aggregate processing counters for the claimed batch.
 * @throws {WorkerError} On fatal protocol or configuration errors, or lease invariants.
 */
export async function processOutbox(
  sql: postgres.Sql,
  syncFn: (event: OutboxEvent) => Promise<boolean> = sendToAPI,
  options: ProcessOutboxOptions = {}
): Promise<ProcessOutboxResult> {
  const engineSchema = assertIdentifier(
    options.engineSchema ?? DEFAULT_ENGINE_SCHEMA,
    "engine schema name"
  );
  const batchSize = resolvePositiveInteger(
    options.batchSize,
    DEFAULT_BATCH_SIZE,
    "batchSize"
  );
  const leaseSeconds = resolvePositiveInteger(
    options.leaseSeconds,
    DEFAULT_LEASE_SECONDS,
    "leaseSeconds"
  );
  const maxAttempts = resolvePositiveInteger(
    options.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    "maxAttempts"
  );
  const baseBackoffMs = resolvePositiveInteger(
    options.baseBackoffMs,
    DEFAULT_BASE_BACKOFF_MS,
    "baseBackoffMs"
  );
  const clock = () => (options.now ? new Date(options.now) : new Date());
  const now = clock();

  const { leaseToken, events } = await claimOutboxBatch(
    sql,
    engineSchema,
    batchSize,
    leaseSeconds,
    now
  );

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
