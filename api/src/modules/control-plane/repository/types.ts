import type postgres from "postgres";
import type {
  CreateErasureRequestInput,
  ErasureRequestStatus,
  ErasureTriggerSource,
  OutboxEventType,
} from "../schemas";

/**
 * Persisted worker client authorized to sync and push outbox events.
 */
export interface ClientRow {
  id: string;
  name: string;
  display_name: string | null;
  worker_api_key_hash: string;
  current_key_id: string;
  is_active: boolean;
  rotated_at: Date;
  last_authenticated_at: Date | null;
  created_at: Date;
}

/**
 * Erasure lifecycle aggregate owned by the Control Plane.
 */
export interface ErasureJobRow {
  id: string;
  client_id: string;
  idempotency_key: string;
  subject_opaque_id: string;
  trigger_source: ErasureTriggerSource;
  actor_opaque_id: string;
  legal_framework: string;
  request_timestamp: Date;
  tenant_id: string | null;
  cooldown_days: number;
  shadow_mode: boolean;
  webhook_url: string | null;
  status: ErasureRequestStatus;
  vault_due_at: Date;
  notification_due_at: Date | null;
  shred_due_at: Date | null;
  shredded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Individual worker task leased by the Control Plane.
 */
export interface TaskQueueRow {
  id: string;
  client_id: string;
  erasure_job_id: string;
  task_type: "VAULT_USER" | "NOTIFY_USER" | "SHRED_USER";
  payload: Record<string, unknown>;
  status: "QUEUED" | "DISPATCHED" | "COMPLETED" | "FAILED" | "DEAD_LETTER";
  worker_client_name: string | null;
  leased_at: Date | null;
  lease_expires_at: Date | null;
  completed_at: Date | null;
  attempt_count: number;
  next_attempt_at: Date;
  dead_lettered_at: Date | null;
  error_text: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Signed Certificate of Erasure persisted for terminal lifecycle events.
 */
export interface CertificateRow {
  request_id: string;
  subject_opaque_id: string;
  method: string;
  legal_framework: string;
  shredded_at: Date;
  payload: Record<string, unknown>;
  signature_base64: string;
  public_key_spki_base64: string;
  key_id: string;
  algorithm: string;
  created_at: Date;
}

/**
 * WORM audit ledger row appended by worker outbox ingestion.
 */
export interface AuditLedgerRow {
  id: string;
  ledger_seq: number;
  client_id: string;
  worker_idempotency_key: string;
  event_type: string;
  payload: unknown;
  previous_hash: string;
  current_hash: string;
  created_at: Date;
}

/**
 * Immutable usage/billing record derived from billable Control Plane events.
 */
export interface UsageEventRow {
  id: string;
  billing_key: string;
  client_id: string;
  erasure_job_id: string | null;
  audit_ledger_id: string | null;
  event_type: string;
  units: number;
  metadata: Record<string, unknown>;
  occurred_at: Date;
  created_at: Date;
}

/**
 * Aggregated usage summary grouped by client and billable event type.
 */
export interface UsageSummaryRow {
  client_name: string;
  event_type: string;
  total_units: number;
  event_count: number;
}

/**
 * Shared repository dependencies passed into feature-specific persistence helpers.
 */
export interface RepositoryContext {
  sql: postgres.Sql;
  schema: string;
  taskLeaseSeconds: number;
  taskMaxAttempts: number;
  taskBaseBackoffMs: number;
}

/**
 * Input required to create a new worker client and issue its initial raw token.
 */
export interface CreateClientInput {
  name: string;
  displayName?: string | null;
  workerApiKeyHash: string;
  currentKeyId: string;
  now: Date;
}

/**
 * Input required to rotate an existing worker client token.
 */
export interface RotateClientKeyInput {
  name: string;
  workerApiKeyHash: string;
  currentKeyId: string;
  now: Date;
}

/**
 * Result returned after creating a new erasure job and its initial worker task.
 */
export interface CreatedJobRecord {
  job: ErasureJobRow;
  task: TaskQueueRow;
}

/**
 * Internal worker failure envelope persisted on failed task acknowledgements.
 */
export interface TaskFailureEnvelope {
  error?: {
    retryable?: boolean;
    fatal?: boolean;
  };
}

/**
 * Deferred tasks that the Control Plane materializes from persisted lifecycle timestamps.
 */
export type DeferredLifecycleTaskType = "NOTIFY_USER" | "SHRED_USER";

/**
 * Input required to create a new erasure job and queue the initial `VAULT_USER` task.
 */
export interface CreateJobAndQueueTaskInput {
  jobId: string;
  taskId: string;
  clientId: string;
  request: CreateErasureRequestInput;
  payload: Record<string, unknown>;
  now: Date;
}

/**
 * Input required to append an audit ledger event.
 */
export interface InsertAuditLedgerEventInput {
  clientId: string;
  idempotencyKey: string;
  eventType: OutboxEventType;
  payload: unknown;
  previousHash: string;
  currentHash: string;
  now: Date;
}

/**
 * Input required to persist a terminal certificate.
 */
export interface InsertCertificateInput {
  requestId: string;
  subjectOpaqueId: string;
  method: string;
  legalFramework: string;
  shreddedAt: Date;
  payload: Record<string, unknown>;
  signatureBase64: string;
  publicKeySpkiBase64: string;
  keyId: string;
  algorithm: string;
}

/**
 * Input required to append a billable usage event.
 */
export interface InsertUsageEventInput {
  billingKey: string;
  clientId: string;
  erasureJobId?: string | null;
  auditLedgerId?: string | null;
  eventType: string;
  units: number;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * Input required to transition a job from an accepted worker outbox event.
 */
export interface TransitionJobFromOutboxInput {
  jobId: string;
  eventType: OutboxEventType;
  now: Date;
  notificationDueAt?: Date;
  shredDueAt?: Date;
  shreddedAt?: Date;
}

/**
 * Calculates exponential backoff for Control Plane task retries, capped at five minutes.
 *
 * @param attemptNumber - Attempt count after the failure being processed.
 * @param baseBackoffMs - Configured base backoff duration in milliseconds.
 * @returns Retry delay in milliseconds.
 */
export function calculateTaskRetryDelayMs(
  attemptNumber: number,
  baseBackoffMs: number
): number {
  return Math.min(
    baseBackoffMs * 2 ** Math.max(0, attemptNumber - 1),
    5 * 60 * 1000
  );
}

/**
 * Interprets the worker's failure envelope to decide whether a task should be retried.
 *
 * @param result - Worker acknowledgement result payload.
 * @returns `true` when the Control Plane should requeue the task.
 */
export function shouldRetryTaskFailure(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return true;
  }

  const failure = result as TaskFailureEnvelope;
  if (!failure.error || typeof failure.error !== "object") {
    return true;
  }

  if (failure.error.fatal === true) {
    return false;
  }

  return failure.error.retryable !== false;
}
