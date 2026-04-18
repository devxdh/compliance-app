import type postgres from "postgres";

export interface ErasureRequestRow {
  id: string;
  client_id: string;
  target_hash: string;
  legal_basis: string;
  retention_years: number;
  status: "REQUESTED" | "VAULTED" | "NOTICE_SENT" | "SHREDDED" | "FAILED";
  shredded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkerTaskRow {
  id: string;
  request_id: string;
  worker_client_id: string | null;
  task_type: "VAULT_USER";
  payload: Record<string, unknown>;
  status: "pending" | "leased" | "completed" | "failed";
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

interface WorkerOutboxInsertRow {
  id: string;
}

/**
 * Postgres.js repository for control-plane state.
 */
export class ControlPlaneRepository {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly schema: string,
    private readonly taskLeaseSeconds: number
  ) {}

  async createRequestWithVaultTask(input: {
    requestId: string;
    taskId: string;
    clientId: string;
    targetHash: string;
    legalBasis: string;
    retentionYears: number;
    userId: number;
    now: Date;
  }) {
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO ${tx(this.schema)}.erasure_requests (
          id, client_id, target_hash, legal_basis, retention_years, status, created_at, updated_at
        ) VALUES (
          ${input.requestId},
          ${input.clientId},
          ${input.targetHash},
          ${input.legalBasis},
          ${input.retentionYears},
          'REQUESTED',
          ${input.now},
          ${input.now}
        )
      `;

      await tx`
        INSERT INTO ${tx(this.schema)}.worker_tasks (
          id, request_id, task_type, payload, status, created_at, updated_at
        ) VALUES (
          ${input.taskId},
          ${input.requestId},
          'VAULT_USER',
          ${tx.json({ userId: input.userId } as postgres.JSONValue)},
          'pending',
          ${input.now},
          ${input.now}
        )
      `;
    });
  }

  async claimNextTask(workerClientId: string, now: Date): Promise<WorkerTaskRow | null> {
    return this.sql.begin(async (tx) => {
      const [candidate] = await tx<WorkerTaskRow[]>`
        SELECT *
        FROM ${tx(this.schema)}.worker_tasks
        WHERE status IN ('pending', 'leased')
          AND (status = 'pending' OR lease_expires_at IS NULL OR lease_expires_at <= ${now})
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      if (!candidate) {
        return null;
      }

      const leaseExpiresAt = new Date(now.getTime() + this.taskLeaseSeconds * 1000);
      const [leased] = await tx<WorkerTaskRow[]>`
        UPDATE ${tx(this.schema)}.worker_tasks
        SET status = 'leased',
            worker_client_id = ${workerClientId},
            leased_at = ${now},
            lease_expires_at = ${leaseExpiresAt},
            updated_at = ${now}
        WHERE id = ${candidate.id}
        RETURNING *
      `;

      return leased ?? null;
    });
  }

  async getTaskById(taskId: string): Promise<WorkerTaskRow | null> {
    const [task] = await this.sql<WorkerTaskRow[]>`
      SELECT * FROM ${this.sql(this.schema)}.worker_tasks WHERE id = ${taskId}
    `;
    return task ?? null;
  }

  async ackTask(taskId: string, status: "completed" | "failed", result: unknown, now: Date): Promise<WorkerTaskRow | null> {
    return this.sql.begin(async (tx) => {
      const [task] = await tx<WorkerTaskRow[]>`
        SELECT * FROM ${tx(this.schema)}.worker_tasks WHERE id = ${taskId} FOR UPDATE
      `;
      if (!task) {
        return null;
      }

      if (task.status === "completed" || task.status === "failed") {
        return task;
      }

      const [updated] = await tx<WorkerTaskRow[]>`
        UPDATE ${tx(this.schema)}.worker_tasks
        SET status = ${status},
            completed_at = ${now},
            error_text = ${status === "failed" ? JSON.stringify(result) : null},
            lease_expires_at = NULL,
            updated_at = ${now}
        WHERE id = ${taskId}
        RETURNING *
      `;

      if (status === "failed") {
        await tx`
          UPDATE ${tx(this.schema)}.erasure_requests
          SET status = 'FAILED',
              updated_at = ${now}
          WHERE id = ${task.request_id}
        `;
      }

      return updated ?? null;
    });
  }

  async recordWorkerOutboxEvent(input: {
    idempotencyKey: string;
    requestId: string;
    targetHash: string;
    eventType: "USER_VAULTED" | "NOTIFICATION_SENT" | "SHRED_SUCCESS";
    payload: unknown;
    eventTimestamp: Date;
    now: Date;
  }): Promise<boolean> {
    const rows = await this.sql<WorkerOutboxInsertRow[]>`
      INSERT INTO ${this.sql(this.schema)}.worker_outbox_events (
        idempotency_key, request_id, target_hash, event_type, payload, event_timestamp, received_at
      ) VALUES (
        ${input.idempotencyKey},
        ${input.requestId},
        ${input.targetHash},
        ${input.eventType},
        ${this.sql.json(input.payload as postgres.JSONValue)},
        ${input.eventTimestamp},
        ${input.now}
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    `;

    return rows.length > 0;
  }

  async transitionRequestFromOutbox(input: {
    requestId: string;
    eventType: "USER_VAULTED" | "NOTIFICATION_SENT" | "SHRED_SUCCESS";
    now: Date;
    shreddedAt?: Date;
  }) {
    const nextStatus =
      input.eventType === "USER_VAULTED"
        ? "VAULTED"
        : input.eventType === "NOTIFICATION_SENT"
          ? "NOTICE_SENT"
          : "SHREDDED";

    await this.sql`
      UPDATE ${this.sql(this.schema)}.erasure_requests
      SET status = ${nextStatus},
          shredded_at = ${input.eventType === "SHRED_SUCCESS" ? input.shreddedAt ?? input.now : null},
          updated_at = ${input.now}
      WHERE id = ${input.requestId}
    `;
  }

  async getRequestById(requestId: string): Promise<ErasureRequestRow | null> {
    const [request] = await this.sql<ErasureRequestRow[]>`
      SELECT * FROM ${this.sql(this.schema)}.erasure_requests WHERE id = ${requestId}
    `;
    return request ?? null;
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

