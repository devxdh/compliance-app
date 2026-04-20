import type postgres from "postgres";
import {
  getAuditEventByIdempotencyKey,
  getLatestAuditHash,
  insertAuditLedgerEvent,
} from "./repository.audit";
import {
  getCertificateByRequestId,
  insertCertificate,
} from "./repository.certificates";
import { ensureClient, getClientByName } from "./repository.clients";
import {
  cancelWaitingJobByIdempotencyKey,
  createJobAndQueueTask,
  getJobById,
  getJobByIdempotencyKey,
  transitionJobFromOutbox,
} from "./repository.jobs";
import { ackTask, claimNextTask, getTaskByJobId } from "./repository.tasks";
import type {
  AuditLedgerRow,
  CertificateRow,
  ClientRow,
  CreateJobAndQueueTaskInput,
  CreatedJobRecord,
  ErasureJobRow,
  InsertAuditLedgerEventInput,
  InsertCertificateInput,
  RepositoryContext,
  TaskQueueRow,
  TransitionJobFromOutboxInput,
} from "./repository.types";

export type {
  AuditLedgerRow,
  CertificateRow,
  ClientRow,
  CreatedJobRecord,
  ErasureJobRow,
  TaskQueueRow,
} from "./repository.types";

/**
 * Postgres.js repository for the control-plane state machine.
 *
 * The class is intentionally thin: each lifecycle area is implemented in a feature-scoped
 * helper module, while this public repository remains the stable integration surface consumed
 * by the service layer.
 */
export class ControlPlaneRepository {
  private readonly context: RepositoryContext;

  constructor(
    sql: postgres.Sql,
    schema: string,
    taskLeaseSeconds: number,
    taskMaxAttempts: number,
    taskBaseBackoffMs: number
  ) {
    this.context = {
      sql,
      schema,
      taskLeaseSeconds,
      taskMaxAttempts,
      taskBaseBackoffMs,
    };
  }

  /**
   * Upserts a worker client record and rotates its token hash atomically.
   *
   * @param name - Stable worker client name.
   * @param workerApiKeyHash - SHA-256 digest of worker bearer token.
   * @returns Persisted client row.
   */
  async ensureClient(name: string, workerApiKeyHash: string): Promise<ClientRow> {
    return ensureClient(this.context, name, workerApiKeyHash);
  }

  /**
   * Finds a registered worker client by name.
   *
   * @param name - Worker client name.
   * @returns Matching client row or `null`.
   */
  async getClientByName(name: string): Promise<ClientRow | null> {
    return getClientByName(this.context, name);
  }

  /**
   * Fetches an erasure job by request id.
   *
   * @param jobId - Erasure job UUID.
   * @returns Job row or `null`.
   */
  async getJobById(jobId: string): Promise<ErasureJobRow | null> {
    return getJobById(this.context, jobId);
  }

  /**
   * Fetches an erasure job by idempotency key.
   *
   * @param idempotencyKey - Request idempotency UUID.
   * @returns Job row or `null`.
   */
  async getJobByIdempotencyKey(idempotencyKey: string): Promise<ErasureJobRow | null> {
    return getJobByIdempotencyKey(this.context, idempotencyKey);
  }

  /**
   * Fetches the earliest task associated with a job.
   *
   * @param jobId - Erasure job UUID.
   * @returns Task row or `null`.
   */
  async getTaskByJobId(jobId: string): Promise<TaskQueueRow | null> {
    return getTaskByJobId(this.context, jobId);
  }

  /**
   * Creates an erasure job and initial `VAULT_USER` task in one transaction.
   *
   * @param input - Precomputed ids, normalized request payload, and timestamp.
   * @returns Inserted job and task rows.
   */
  async createJobAndQueueTask(input: CreateJobAndQueueTaskInput): Promise<CreatedJobRecord> {
    return createJobAndQueueTask(this.context, input);
  }

  /**
   * Cancels a job only when it is still in `WAITING_COOLDOWN`.
   *
   * @param idempotencyKey - Request idempotency UUID.
   * @param now - Update timestamp.
   * @returns Cancelled job row or `null`.
   */
  async cancelWaitingJobByIdempotencyKey(
    idempotencyKey: string,
    now: Date
  ): Promise<ErasureJobRow | null> {
    return cancelWaitingJobByIdempotencyKey(this.context, idempotencyKey, now);
  }

  /**
   * Claims the next due task using `FOR UPDATE SKIP LOCKED` leasing semantics.
   *
   * @param clientId - Authenticated worker client id.
   * @param workerClientName - Worker client name recorded in lease metadata.
   * @param now - Lease anchor timestamp.
   * @returns Leased task row or `null`.
   */
  async claimNextTask(
    clientId: string,
    workerClientName: string,
    now: Date
  ): Promise<TaskQueueRow | null> {
    return claimNextTask(this.context, clientId, workerClientName, now);
  }

  /**
   * Acknowledges task completion or failure and applies retry/DLQ state transitions.
   *
   * @param taskId - Task UUID.
   * @param status - Worker ack status.
   * @param result - Worker result payload persisted for diagnostics.
   * @param now - Completion timestamp.
   * @returns Updated task row or `null` when task is missing.
   */
  async ackTask(
    taskId: string,
    status: "completed" | "failed",
    result: unknown,
    now: Date
  ): Promise<TaskQueueRow | null> {
    return ackTask(this.context, taskId, status, result, now);
  }

  /**
   * Reads the latest WORM hash pointer for a client.
   *
   * @param clientId - Worker client id.
   * @returns Current chain head hash or `null`.
   */
  async getLatestAuditHash(clientId: string): Promise<string | null> {
    return getLatestAuditHash(this.context, clientId);
  }

  /**
   * Appends one audit ledger event with idempotent conflict handling.
   *
   * @param input - Event envelope and chain hashes.
   * @returns `true` when inserted, `false` when conflict indicates replay.
   */
  async insertAuditLedgerEvent(input: InsertAuditLedgerEventInput): Promise<boolean> {
    return insertAuditLedgerEvent(this.context, input);
  }

  /**
   * Fetches a previously ingested audit event by its global idempotency key.
   *
   * @param idempotencyKey - Worker idempotency key.
   * @returns Matching audit event or `null`.
   */
  async getAuditEventByIdempotencyKey(
    idempotencyKey: string
  ): Promise<AuditLedgerRow | null> {
    return getAuditEventByIdempotencyKey(this.context, idempotencyKey);
  }

  /**
   * Transitions erasure job state from worker outbox event semantics.
   *
   * @param input - Job id, event type, and timestamps.
   */
  async transitionJobFromOutbox(input: TransitionJobFromOutboxInput): Promise<void> {
    return transitionJobFromOutbox(this.context, input);
  }

  /**
   * Inserts a signed Certificate of Erasure idempotently.
   *
   * @param input - Persisted certificate payload and signature envelope.
   * @returns `true` when inserted, `false` when certificate already exists.
   */
  async insertCertificate(input: InsertCertificateInput): Promise<boolean> {
    return insertCertificate(this.context, input);
  }

  /**
   * Fetches minted certificate by request id.
   *
   * @param requestId - Erasure request UUID.
   * @returns Certificate row or `null`.
   */
  async getCertificateByRequestId(
    requestId: string
  ): Promise<CertificateRow | null> {
    return getCertificateByRequestId(this.context, requestId);
  }
}
