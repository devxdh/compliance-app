import type postgres from "postgres";
import type {
  CreateErasureRequestInput,
  ErasureRequestStatus,
  ErasureTriggerSource,
  OutboxEventType,
} from "./schemas";

export interface ClientRow {
  id: string;
  name: string;
  worker_api_key_hash: string;
  created_at: Date;
}

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

interface CreatedJobRecord {
  job: ErasureJobRow;
  task: TaskQueueRow;
}

interface TaskFailureEnvelope {
  error?: {
    retryable?: boolean;
    fatal?: boolean;
  };
}

type DeferredLifecycleTaskType = "NOTIFY_USER" | "SHRED_USER";

function calculateTaskRetryDelayMs(attemptNumber: number, baseBackoffMs: number): number {
  return Math.min(baseBackoffMs * 2 ** Math.max(0, attemptNumber - 1), 5 * 60 * 1000);
}

function shouldRetryTaskFailure(result: unknown): boolean {
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

/**
 * Postgres.js repository for the control-plane state machine.
 */
export class ControlPlaneRepository {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly schema: string,
    private readonly taskLeaseSeconds: number,
    private readonly taskMaxAttempts: number,
    private readonly taskBaseBackoffMs: number
  ) {}

  /**
   * Upserts a worker client record and rotates its token hash atomically.
   *
   * @param name - Stable worker client name.
   * @param workerApiKeyHash - SHA-256 digest of worker bearer token.
   * @returns Persisted client row.
   */
  async ensureClient(name: string, workerApiKeyHash: string): Promise<ClientRow> {
    const [row] = await this.sql<ClientRow[]>`
      INSERT INTO ${this.sql(this.schema)}.clients (name, worker_api_key_hash)
      VALUES (${name}, ${workerApiKeyHash})
      ON CONFLICT (name) DO UPDATE
        SET worker_api_key_hash = EXCLUDED.worker_api_key_hash
      RETURNING *
    `;
    return row!;
  }

  /**
   * Finds a registered worker client by name.
   *
   * @param name - Worker client name.
   * @returns Matching client row or `null`.
   */
  async getClientByName(name: string): Promise<ClientRow | null> {
    const [row] = await this.sql<ClientRow[]>`
      SELECT *
      FROM ${this.sql(this.schema)}.clients
      WHERE name = ${name}
    `;
    return row ?? null;
  }

  /**
   * Fetches an erasure job by request id.
   *
   * @param jobId - Erasure job UUID.
   * @returns Job row or `null`.
   */
  async getJobById(jobId: string): Promise<ErasureJobRow | null> {
    const [job] = await this.sql<ErasureJobRow[]>`
      SELECT *
      FROM ${this.sql(this.schema)}.erasure_jobs
      WHERE id = ${jobId}
    `;
    return job ?? null;
  }

  /**
   * Fetches an erasure job by idempotency key.
   *
   * @param idempotencyKey - Request idempotency UUID.
   * @returns Job row or `null`.
   */
  async getJobByIdempotencyKey(idempotencyKey: string): Promise<ErasureJobRow | null> {
    const [job] = await this.sql<ErasureJobRow[]>`
      SELECT *
      FROM ${this.sql(this.schema)}.erasure_jobs
      WHERE idempotency_key = ${idempotencyKey}::uuid
    `;
    return job ?? null;
  }

  /**
   * Fetches the earliest task associated with a job.
   *
   * @param jobId - Erasure job UUID.
   * @returns Task row or `null`.
   */
  async getTaskByJobId(jobId: string): Promise<TaskQueueRow | null> {
    const [task] = await this.sql<TaskQueueRow[]>`
      SELECT *
      FROM ${this.sql(this.schema)}.task_queue
      WHERE erasure_job_id = ${jobId}
      ORDER BY created_at ASC
      LIMIT 1
    `;
    return task ?? null;
  }

  /**
   * Creates an erasure job and initial `VAULT_USER` task in one transaction.
   *
   * @param input - Precomputed ids, normalized request payload, and timestamp.
   * @returns Inserted job + task rows.
   */
  async createJobAndQueueTask(input: {
    jobId: string;
    taskId: string;
    clientId: string;
    request: CreateErasureRequestInput;
    payload: Record<string, unknown>;
    now: Date;
  }): Promise<CreatedJobRecord> {
    return this.sql.begin(async (tx) => {
      const [job] = await tx<ErasureJobRow[]>`
        INSERT INTO ${tx(this.schema)}.erasure_jobs (
          id,
          client_id,
          idempotency_key,
          subject_opaque_id,
          trigger_source,
          actor_opaque_id,
          legal_framework,
          request_timestamp,
          tenant_id,
          cooldown_days,
          shadow_mode,
          webhook_url,
          status,
          vault_due_at,
          created_at,
          updated_at
        )
        VALUES (
          ${input.jobId},
          ${input.clientId},
          ${input.request.idempotency_key}::uuid,
          ${input.request.subject_opaque_id},
          ${input.request.trigger_source},
          ${input.request.actor_opaque_id},
          ${input.request.legal_framework},
          ${new Date(input.request.request_timestamp)},
          ${input.request.tenant_id ?? null},
          ${input.request.cooldown_days},
          ${input.request.shadow_mode},
          ${input.request.webhook_url ?? null},
          'WAITING_COOLDOWN',
          NOW() + MAKE_INTERVAL(days := ${input.request.cooldown_days}),
          ${input.now},
          ${input.now}
        )
        RETURNING *
      `;

      const [task] = await tx<TaskQueueRow[]>`
        INSERT INTO ${tx(this.schema)}.task_queue (
          id,
          client_id,
          erasure_job_id,
          task_type,
          payload,
          status,
          attempt_count,
          next_attempt_at,
          created_at,
          updated_at
        )
        VALUES (
          ${input.taskId},
          ${input.clientId},
          ${input.jobId},
          'VAULT_USER',
          ${tx.json(input.payload as postgres.JSONValue)},
          'QUEUED',
          0,
          ${input.now},
          ${input.now},
          ${input.now}
        )
        RETURNING *
      `;

      return { job: job!, task: task! };
    });
  }

  /**
   * Cancels a job only when it is still in `WAITING_COOLDOWN`.
   *
   * @param idempotencyKey - Request idempotency UUID.
   * @param now - Update timestamp.
   * @returns Cancelled job row or `null` if no eligible job was found.
   */
  async cancelWaitingJobByIdempotencyKey(idempotencyKey: string, now: Date): Promise<ErasureJobRow | null> {
    return this.sql.begin(async (tx) => {
      const [job] = await tx<ErasureJobRow[]>`
        UPDATE ${tx(this.schema)}.erasure_jobs
        SET status = 'CANCELLED',
            updated_at = ${now}
        WHERE idempotency_key = ${idempotencyKey}::uuid
          AND status = 'WAITING_COOLDOWN'
        RETURNING *
      `;

      if (!job) {
        return null;
      }

      await tx`
        UPDATE ${tx(this.schema)}.task_queue
        SET status = 'FAILED',
            completed_at = ${now},
            lease_expires_at = NULL,
            error_text = ${JSON.stringify({
              code: "API_TASK_CANCELLED",
              detail: "Task cancelled because erasure request moved to CANCELLED during cooldown.",
            })},
            updated_at = ${now}
        WHERE erasure_job_id = ${job.id}
          AND status IN ('QUEUED', 'DISPATCHED')
      `;

      return job;
    });
  }

  /**
   * Materializes lifecycle tasks whose due timestamps have elapsed.
   *
   * The Control Plane remains the sole owner of time. It persists the Worker-computed
   * `notification_due_at` and `shred_due_at` timestamps, then lazily translates them into
   * executable tasks just before leasing. Inserts are idempotent via `(erasure_job_id, task_type)`.
   *
   * @param tx - Transaction-scoped Postgres handle.
   * @param clientId - Authenticated worker client id.
   * @param now - Scheduler clock anchor.
   * @returns Promise resolved once due tasks have been upserted.
   */
  private async materializeDueLifecycleTasks(
    tx: postgres.TransactionSql,
    clientId: string,
    now: Date
  ): Promise<void> {
    const buildLifecyclePayload = () => tx`
      jsonb_strip_nulls(
        jsonb_build_object(
          'request_id', ej.id,
          'subject_opaque_id', ej.subject_opaque_id,
          'idempotency_key', ej.idempotency_key::text,
          'trigger_source', ej.trigger_source,
          'actor_opaque_id', ej.actor_opaque_id,
          'legal_framework', ej.legal_framework,
          'request_timestamp', ej.request_timestamp,
          'tenant_id', ej.tenant_id,
          'cooldown_days', ej.cooldown_days,
          'shadow_mode', ej.shadow_mode,
          'webhook_url', ej.webhook_url
        )
      )
    `;

    const insertLifecycleTask = async (taskType: DeferredLifecycleTaskType) => {
      const dueColumn = taskType === "NOTIFY_USER" ? tx`ej.notification_due_at` : tx`ej.shred_due_at`;
      const requiredStatus = taskType === "NOTIFY_USER" ? "VAULTED" : "NOTICE_SENT";

      await tx`
        INSERT INTO ${tx(this.schema)}.task_queue (
          id,
          client_id,
          erasure_job_id,
          task_type,
          payload,
          status,
          attempt_count,
          next_attempt_at,
          created_at,
          updated_at
        )
        SELECT
          gen_random_uuid(),
          ej.client_id,
          ej.id,
          ${taskType},
          ${buildLifecyclePayload()},
          'QUEUED',
          0,
          ${now},
          ${now},
          ${now}
        FROM ${tx(this.schema)}.erasure_jobs AS ej
        WHERE ej.client_id = ${clientId}
          AND ej.status = ${requiredStatus}
          AND ${dueColumn} IS NOT NULL
          AND ${dueColumn} <= ${now}
        ON CONFLICT (erasure_job_id, task_type) DO NOTHING
      `;
    };

    await insertLifecycleTask("NOTIFY_USER");
    await insertLifecycleTask("SHRED_USER");
  }

  /**
   * Claims the next due task using `FOR UPDATE SKIP LOCKED` leasing semantics.
   *
   * @param clientId - Authenticated worker client id.
   * @param workerClientName - Worker client name recorded in lease metadata.
   * @param now - Lease anchor timestamp.
   * @returns Leased task row or `null` when no due task is available.
   */
  async claimNextTask(clientId: string, workerClientName: string, now: Date): Promise<TaskQueueRow | null> {
    return this.sql.begin(async (tx) => {
      await this.materializeDueLifecycleTasks(tx, clientId, now);

      const [candidate] = await tx<TaskQueueRow[]>`
        SELECT tq.*
        FROM ${tx(this.schema)}.task_queue AS tq
        JOIN ${tx(this.schema)}.erasure_jobs AS ej
          ON ej.id = tq.erasure_job_id
        WHERE tq.client_id = ${clientId}
          AND tq.status IN ('QUEUED', 'DISPATCHED')
          AND tq.next_attempt_at <= ${now}
          AND (tq.status = 'QUEUED' OR tq.lease_expires_at IS NULL OR tq.lease_expires_at <= ${now})
          AND ej.status NOT IN ('CANCELLED', 'SHREDDED', 'FAILED')
          AND (
            (tq.task_type = 'VAULT_USER' AND ej.vault_due_at <= NOW())
            OR (tq.task_type = 'NOTIFY_USER' AND ej.notification_due_at IS NOT NULL AND ej.notification_due_at <= ${now})
            OR (tq.task_type = 'SHRED_USER' AND ej.shred_due_at IS NOT NULL AND ej.shred_due_at <= ${now})
          )
        ORDER BY
          CASE
            WHEN tq.task_type = 'VAULT_USER' THEN ej.vault_due_at
            WHEN tq.task_type = 'NOTIFY_USER' THEN ej.notification_due_at
            ELSE ej.shred_due_at
          END ASC,
          tq.next_attempt_at ASC,
          tq.created_at ASC
        LIMIT 1
        FOR UPDATE OF tq, ej SKIP LOCKED
      `;

      if (!candidate) {
        return null;
      }

      const leaseExpiresAt = new Date(now.getTime() + this.taskLeaseSeconds * 1000);
      const [leased] = await tx<TaskQueueRow[]>`
        UPDATE ${tx(this.schema)}.task_queue
        SET status = 'DISPATCHED',
            worker_client_name = ${workerClientName},
            leased_at = ${now},
            lease_expires_at = ${leaseExpiresAt},
            updated_at = ${now}
        WHERE id = ${candidate.id}
        RETURNING *
      `;

      await tx`
        UPDATE ${tx(this.schema)}.erasure_jobs
        SET status = CASE WHEN status = 'WAITING_COOLDOWN' THEN 'EXECUTING' ELSE status END,
            updated_at = ${now}
        WHERE id = ${candidate.erasure_job_id}
      `;

      return leased ?? null;
    });
  }

  /**
   * Acknowledges task completion/failure and applies retry/DLQ state transitions.
   *
   * Failed tasks are re-queued with exponential backoff when the worker reports a retryable error.
   * Non-retryable failures, fatal failures, or attempts that exhaust the configured ceiling are routed
   * to `DEAD_LETTER`, and the parent erasure job is marked `FAILED`.
   *
   * @param taskId - Task UUID.
   * @param status - Worker ack status.
   * @param result - Worker result payload persisted for diagnostics.
   * @param now - Completion timestamp.
   * @returns Updated task row, current non-dispatched row, or `null` when task is missing.
   */
  async ackTask(taskId: string, status: "completed" | "failed", result: unknown, now: Date): Promise<TaskQueueRow | null> {
    return this.sql.begin(async (tx) => {
      const [task] = await tx<TaskQueueRow[]>`
        SELECT *
        FROM ${tx(this.schema)}.task_queue
        WHERE id = ${taskId}
        FOR UPDATE
      `;

      if (!task) {
        return null;
      }

      if (task.status !== "DISPATCHED") {
        return task;
      }

      if (status === "completed") {
        const [updated] = await tx<TaskQueueRow[]>`
          UPDATE ${tx(this.schema)}.task_queue
          SET status = 'COMPLETED',
              completed_at = ${now},
              error_text = NULL,
              lease_expires_at = NULL,
              updated_at = ${now}
          WHERE id = ${taskId}
          RETURNING *
        `;

        return updated ?? null;
      }

      const attemptNumber = task.attempt_count + 1;
      const retryable = shouldRetryTaskFailure(result);
      const exhausted = attemptNumber >= this.taskMaxAttempts;

      if (!retryable || exhausted) {
        const [updated] = await tx<TaskQueueRow[]>`
          UPDATE ${tx(this.schema)}.task_queue
          SET status = 'DEAD_LETTER',
              attempt_count = ${attemptNumber},
              completed_at = ${now},
              dead_lettered_at = ${now},
              error_text = ${JSON.stringify(result)},
              lease_expires_at = NULL,
              updated_at = ${now}
          WHERE id = ${taskId}
          RETURNING *
        `;

        await tx`
          UPDATE ${tx(this.schema)}.erasure_jobs
          SET status = 'FAILED',
              updated_at = ${now}
          WHERE id = ${task.erasure_job_id}
        `;

        return updated ?? null;
      }

      const retryDelayMs = calculateTaskRetryDelayMs(attemptNumber, this.taskBaseBackoffMs);
      const [updated] = await tx<TaskQueueRow[]>`
        UPDATE ${tx(this.schema)}.task_queue
        SET status = 'QUEUED',
            worker_client_name = NULL,
            leased_at = NULL,
            lease_expires_at = NULL,
            completed_at = NULL,
            attempt_count = ${attemptNumber},
            next_attempt_at = ${now}::timestamptz + (${retryDelayMs} * interval '1 millisecond'),
            error_text = ${JSON.stringify(result)},
            updated_at = ${now}
        WHERE id = ${taskId}
        RETURNING *
      `;

      return updated ?? null;
    });
  }

  /**
   * Reads the latest WORM hash pointer for a client in O(1) using the sequence index.
   *
   * @param clientId - Worker client id.
   * @returns Current chain head hash or `null` for genesis state.
   */
  async getLatestAuditHash(clientId: string): Promise<string | null> {
    const [row] = await this.sql<{ current_hash: string }[]>`
      SELECT current_hash
      FROM ${this.sql(this.schema)}.audit_ledger
      WHERE client_id = ${clientId}
      ORDER BY ledger_seq DESC
      LIMIT 1
    `;
    return row?.current_hash ?? null;
  }

  /**
   * Appends one audit ledger event with idempotent conflict handling.
   *
   * @param input - Event envelope and chain hashes.
   * @returns `true` when inserted, `false` when conflict indicates replay.
   */
  async insertAuditLedgerEvent(input: {
    clientId: string;
    idempotencyKey: string;
    eventType: OutboxEventType;
    payload: unknown;
    previousHash: string;
    currentHash: string;
    now: Date;
  }): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      INSERT INTO ${this.sql(this.schema)}.audit_ledger (
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
        ${this.sql.json(input.payload as postgres.JSONValue)},
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
   * @param idempotencyKey - Worker idempotency key.
   * @returns Matching audit event or `null`.
   */
  async getAuditEventByIdempotencyKey(idempotencyKey: string): Promise<AuditLedgerRow | null> {
    const [row] = await this.sql<AuditLedgerRow[]>`
      SELECT *
      FROM ${this.sql(this.schema)}.audit_ledger
      WHERE worker_idempotency_key = ${idempotencyKey}
    `;
    return row ?? null;
  }

  /**
   * Transitions erasure job state from worker outbox event semantics.
   *
   * @param input - Job id, event type, and timestamps.
   * @returns Promise resolved after status transition update.
   */
  async transitionJobFromOutbox(input: {
    jobId: string;
    eventType: OutboxEventType;
    now: Date;
    notificationDueAt?: Date;
    shredDueAt?: Date;
    shreddedAt?: Date;
  }) {
    const nextState =
      input.eventType === "USER_VAULTED"
        ? "VAULTED"
        : input.eventType === "NOTIFICATION_SENT"
          ? "NOTICE_SENT"
          : "SHREDDED";

    await this.sql`
      UPDATE ${this.sql(this.schema)}.erasure_jobs
      SET status = ${nextState},
          notification_due_at = CASE
            WHEN ${input.eventType === "USER_VAULTED"}
              THEN ${input.notificationDueAt ?? null}
            ELSE notification_due_at
          END,
          shred_due_at = CASE
            WHEN ${input.eventType === "USER_VAULTED"}
              THEN ${input.shredDueAt ?? null}
            ELSE shred_due_at
          END,
          shredded_at = CASE
            WHEN ${input.eventType === "SHRED_SUCCESS" || input.eventType === "USER_HARD_DELETED"}
              THEN ${input.shreddedAt ?? input.now}
            ELSE shredded_at
          END,
          updated_at = ${input.now}
      WHERE id = ${input.jobId}
    `;
  }

  /**
   * Inserts a signed Certificate of Erasure idempotently.
   *
   * @param input - Persisted certificate payload and signature envelope.
   * @returns `true` when inserted, `false` when certificate already exists.
   */
  async insertCertificate(input: {
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
  }): Promise<boolean> {
    const rows = await this.sql<{ request_id: string }[]>`
      INSERT INTO ${this.sql(this.schema)}.certificates (
        request_id,
        subject_opaque_id,
        method,
        legal_framework,
        shredded_at,
        payload,
        signature_base64,
        public_key_spki_base64,
        key_id,
        algorithm
      ) VALUES (
        ${input.requestId},
        ${input.subjectOpaqueId},
        ${input.method},
        ${input.legalFramework},
        ${input.shreddedAt},
        ${this.sql.json(input.payload as postgres.JSONValue)},
        ${input.signatureBase64},
        ${input.publicKeySpkiBase64},
        ${input.keyId},
        ${input.algorithm}
      )
      ON CONFLICT (request_id) DO NOTHING
      RETURNING request_id
    `;

    return rows.length > 0;
  }

  /**
   * Fetches minted certificate by request id.
   *
   * @param requestId - Erasure request UUID.
   * @returns Certificate row or `null`.
   */
  async getCertificateByRequestId(requestId: string): Promise<CertificateRow | null> {
    const [certificate] = await this.sql<CertificateRow[]>`
      SELECT *
      FROM ${this.sql(this.schema)}.certificates
      WHERE request_id = ${requestId}
    `;

    return certificate ?? null;
  }
}
