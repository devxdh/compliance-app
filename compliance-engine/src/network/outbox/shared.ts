import { fail } from "../../errors";
import type { OutboxRow } from "../../engine/support";

/**
 * Outbox row type exposed by the relay pipeline.
 */
export interface OutboxEvent extends OutboxRow { }

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
  requestSigningSecret?: string;
  timeoutMs?: number;
}

export const DEFAULT_ENGINE_SCHEMA = "dpdp_engine";
export const DEFAULT_BATCH_SIZE = 10;
export const DEFAULT_LEASE_SECONDS = 60;
export const DEFAULT_MAX_ATTEMPTS = 10;
export const DEFAULT_BASE_BACKOFF_MS = 1000;

/**
 * Validates that an outbox tuning value is a positive integer.
 *
 * @param value - Optional runtime override.
 * @param fallback - Default value when the override is absent.
 * @param label - Human-readable option name for error details.
 * @returns Validated positive integer.
 */
export function resolvePositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string
): number {
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
 * Computes exponential retry delay capped at five minutes.
 *
 * @param attemptNumber - 1-based attempt count.
 * @param baseBackoffMs - Initial backoff duration in milliseconds.
 * @returns Retry delay in milliseconds.
 */
export function calculateRetryDelayMs(
  attemptNumber: number,
  baseBackoffMs: number = DEFAULT_BASE_BACKOFF_MS
): number {
  return Math.min(
    baseBackoffMs * 2 ** Math.max(0, attemptNumber - 1),
    5 * 60 * 1000
  );
}
