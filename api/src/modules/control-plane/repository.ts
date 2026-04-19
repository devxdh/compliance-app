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
  shredded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TaskQueueRow {
  id: string;
  client_id: string;
  erasure_job_id: string;
  task_type: "VAULT_USER";
  payload: Record<string, unknown>;
  status: "QUEUED" | "DISPATCHED" | "COMPLETED" | "FAILED";
  worker_client_name: string | null;
  leased_at: Date | null;
  lease_expires_at: Date | null;
  completed_at: Date | null;
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

/**
 * Postgres.js repository for the control-plane state machine.
 */
export class ControlPlaneRepository {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly schema: string,
    private readonly taskLeaseSeconds: number
  ) {}

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

  async getClientByName(name: string): Promise<ClientRow | null> {
    const [row] = await this.sql<ClientRow[]>`
      SELECT *
      FROM ${this.sql(this.schema)}.clients
      WHERE name = ${name}
    `;
    return row ?? null;
  }

  async getJobById(jobId: string): Promise<ErasureJobRow | null> {
    const [job] = await this.sql<ErasureJobRow[]>`
      SELECT *
      FROM ${this.sql(this.schema)}.erasure_jobs
      WHERE id = ${jobId}
    `;
    return job ?? null;
  }

  async getJobByIdempotencyKey(idempotencyKey: string): Promise<ErasureJobRow | null> {
    const [job] = await this.sql<ErasureJobRow[]>`
      SELECT *
      FROM ${this.sql(this.schema)}.erasure_jobs
      WHERE idempotency_key = ${idempotencyKey}::uuid
    `;
    return job ?? null;
  }

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
          ${input.now},
          ${input.now}
        )
        RETURNING *
      `;

      return { job: job!, task: task! };
    });
  }

  async cancelWaitingJobByIdempotencyKey(idempotencyKey: string, now: Date): Promise<ErasureJobRow | null> {
    const [job] = await this.sql<ErasureJobRow[]>`
      UPDATE ${this.sql(this.schema)}.erasure_jobs
      SET status = 'CANCELLED',
          updated_at = ${now}
      WHERE idempotency_key = ${idempotencyKey}::uuid
        AND status = 'WAITING_COOLDOWN'
      RETURNING *
    `;
    return job ?? null;
  }

  async claimNextTask(clientId: string, workerClientName: string, now: Date): Promise<TaskQueueRow | null> {
    return this.sql.begin(async (tx) => {
      const [candidate] = await tx<TaskQueueRow[]>`
        SELECT tq.*
        FROM ${tx(this.schema)}.task_queue AS tq
        JOIN ${tx(this.schema)}.erasure_jobs AS ej
          ON ej.id = tq.erasure_job_id
        WHERE tq.client_id = ${clientId}
          AND tq.status IN ('QUEUED', 'DISPATCHED')
          AND (tq.status = 'QUEUED' OR tq.lease_expires_at IS NULL OR tq.lease_expires_at <= ${now})
          AND ej.vault_due_at <= NOW()
          AND ej.status NOT IN ('CANCELLED', 'SHREDDED')
        ORDER BY ej.vault_due_at ASC, tq.created_at ASC
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

      if (task.status === "COMPLETED" || task.status === "FAILED") {
        return task;
      }

      const nextTaskState = status === "completed" ? "COMPLETED" : "FAILED";
      const [updated] = await tx<TaskQueueRow[]>`
        UPDATE ${tx(this.schema)}.task_queue
        SET status = ${nextTaskState},
            completed_at = ${now},
            error_text = ${status === "failed" ? JSON.stringify(result) : null},
            lease_expires_at = NULL,
            updated_at = ${now}
        WHERE id = ${taskId}
        RETURNING *
      `;

      if (status === "failed") {
        await tx`
          UPDATE ${tx(this.schema)}.erasure_jobs
          SET status = 'FAILED',
              updated_at = ${now}
          WHERE id = ${task.erasure_job_id}
        `;
      }

      return updated ?? null;
    });
  }

  /**
   * Reads the latest WORM hash pointer for a client in O(1) using the sequence index.
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
   */
  async getAuditEventByIdempotencyKey(idempotencyKey: string): Promise<AuditLedgerRow | null> {
    const [row] = await this.sql<AuditLedgerRow[]>`
      SELECT *
      FROM ${this.sql(this.schema)}.audit_ledger
      WHERE worker_idempotency_key = ${idempotencyKey}
    `;
    return row ?? null;
  }

  async transitionJobFromOutbox(input: {
    jobId: string;
    eventType: OutboxEventType;
    now: Date;
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
          shredded_at = CASE
            WHEN ${input.eventType === "SHRED_SUCCESS" || input.eventType === "USER_HARD_DELETED"}
              THEN ${input.shreddedAt ?? input.now}
            ELSE shredded_at
          END,
          updated_at = ${input.now}
      WHERE id = ${input.jobId}
    `;
  }

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

  async getCertificateByRequestId(requestId: string): Promise<CertificateRow | null> {
    const [certificate] = await this.sql<CertificateRow[]>`
      SELECT *
      FROM ${this.sql(this.schema)}.certificates
      WHERE request_id = ${requestId}
    `;

    return certificate ?? null;
  }
}
