import type postgres from "postgres";

export interface ClientRow {
  id: string;
  name: string;
  worker_api_key_hash: string;
  created_at: Date;
}

export interface ErasureJobRow {
  id: string;
  client_id: string;
  client_internal_user_id: string;
  user_uuid_hash: string;
  legal_basis: string;
  retention_years: number;
  status: "REQUESTED" | "VAULTED" | "NOTICE_SENT" | "SHREDDED" | "FAILED";
  vault_due_at: Date | null;
  shred_due_at: Date | null;
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
  target_hash: string;
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

  async createJobAndQueueTask(input: {
    jobId: string;
    taskId: string;
    clientId: string;
    clientInternalUserId: string;
    userUuidHash: string;
    legalBasis: string;
    retentionYears: number;
    payload: Record<string, unknown>;
    now: Date;
  }) {
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO ${tx(this.schema)}.erasure_jobs (
          id,
          client_id,
          client_internal_user_id,
          user_uuid_hash,
          legal_basis,
          retention_years,
          status,
          created_at,
          updated_at
        ) VALUES (
          ${input.jobId},
          ${input.clientId},
          ${input.clientInternalUserId},
          ${input.userUuidHash},
          ${input.legalBasis},
          ${input.retentionYears},
          'REQUESTED',
          ${input.now},
          ${input.now}
        )
      `;

      await tx`
        INSERT INTO ${tx(this.schema)}.task_queue (
          id,
          client_id,
          erasure_job_id,
          task_type,
          payload,
          status,
          created_at,
          updated_at
        ) VALUES (
          ${input.taskId},
          ${input.clientId},
          ${input.jobId},
          'VAULT_USER',
          ${tx.json(input.payload as postgres.JSONValue)},
          'QUEUED',
          ${input.now},
          ${input.now}
        )
      `;
    });
  }

  async claimNextTask(clientId: string, workerClientName: string, now: Date): Promise<TaskQueueRow | null> {
    return this.sql.begin(async (tx) => {
      const [candidate] = await tx<TaskQueueRow[]>`
        SELECT *
        FROM ${tx(this.schema)}.task_queue
        WHERE client_id = ${clientId}
          AND status IN ('QUEUED', 'DISPATCHED')
          AND (status = 'QUEUED' OR lease_expires_at IS NULL OR lease_expires_at <= ${now})
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
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
      const nextJobState = status === "completed" ? "VAULTED" : "FAILED";

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

      await tx`
        UPDATE ${tx(this.schema)}.erasure_jobs
        SET status = ${nextJobState},
            updated_at = ${now}
        WHERE id = ${task.erasure_job_id}
      `;

      return updated ?? null;
    });
  }

  async getJobById(jobId: string): Promise<ErasureJobRow | null> {
    const [job] = await this.sql<ErasureJobRow[]>`
      SELECT *
      FROM ${this.sql(this.schema)}.erasure_jobs
      WHERE id = ${jobId}
    `;
    return job ?? null;
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
    eventType: "USER_VAULTED" | "NOTIFICATION_SENT" | "SHRED_SUCCESS";
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
    eventType: "USER_VAULTED" | "NOTIFICATION_SENT" | "SHRED_SUCCESS";
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
            WHEN ${input.eventType === "SHRED_SUCCESS"} THEN ${input.shreddedAt ?? input.now}
            ELSE shredded_at
          END,
          updated_at = ${input.now}
      WHERE id = ${input.jobId}
    `;
  }

  async insertCertificate(input: {
    requestId: string;
    targetHash: string;
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
        target_hash,
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
        ${input.targetHash},
        'CRYPTO_SHREDDING_DEK_DELETE',
        'DPDP_SEC_8_7',
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
