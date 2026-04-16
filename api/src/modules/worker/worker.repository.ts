import type postgres from "postgres";
import { sql } from "../../db/index";
import type { JsonObject } from "../../types/common";
import type { TaskAckStatus, WorkerOutboxEvent, WorkerTask } from "../../types/worker";

/**
 * Persistence contract for worker queues/outbox.
 */
export interface WorkerRepository {
  claimNextPendingTask(clientId: string, now: Date, leaseSeconds: number): Promise<WorkerTask | null>;
  enqueueTask(clientId: string, taskType: string, payload: JsonObject, now: Date): Promise<WorkerTask>;
  getTask(taskId: string): Promise<WorkerTask | null>;
  ackTask(taskId: string, status: TaskAckStatus, result: JsonObject | null, error: string | null, now: Date): Promise<WorkerTask | null>;
  insertOutboxEvent(
    clientId: string,
    eventType: string,
    payload: JsonObject,
    idempotencyKey: string | null,
    now: Date
  ): Promise<{ created: boolean; event: WorkerOutboxEvent }>;
  listOutboxEvents(clientId: string, limit: number, offset: number): Promise<WorkerOutboxEvent[]>;
}

function asJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

export class PostgresWorkerRepository implements WorkerRepository {
  async claimNextPendingTask(clientId: string, now: Date, leaseSeconds: number): Promise<WorkerTask | null> {
    return sql.begin(async (tx) => {
      const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
      const leaseToken = globalThis.crypto.randomUUID();

      const tasks = await tx<WorkerTask[]>`
        SELECT *
        FROM pending_tasks
        WHERE client_id = ${clientId}
          AND status = 'pending'
          AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      const task = tasks[0];
      if (!task) {
        return null;
      }

      const updated = await tx<WorkerTask[]>`
        UPDATE pending_tasks
        SET status = 'claimed',
            lease_token = ${leaseToken},
            lease_expires_at = ${leaseExpiresAt},
            claimed_at = ${now},
            attempt_count = attempt_count + 1,
            updated_at = ${now}
        WHERE id = ${task.id}
        RETURNING *
      `;

      return updated[0] ?? null;
    });
  }

  async enqueueTask(clientId: string, taskType: string, payload: JsonObject, now: Date): Promise<WorkerTask> {
    const rows = await sql<WorkerTask[]>`
      INSERT INTO pending_tasks (client_id, task_type, payload, status, created_at, updated_at)
      VALUES (${clientId}, ${taskType}, ${sql.json(asJson(payload))}, 'pending', ${now}, ${now})
      RETURNING *
    `;
    return rows[0]!;
  }

  async getTask(taskId: string): Promise<WorkerTask | null> {
    const rows = await sql<WorkerTask[]>`SELECT * FROM pending_tasks WHERE id = ${taskId} LIMIT 1`;
    return rows[0] ?? null;
  }

  async ackTask(
    taskId: string,
    status: TaskAckStatus,
    result: JsonObject | null,
    error: string | null,
    now: Date
  ): Promise<WorkerTask | null> {
    const rows = await sql<WorkerTask[]>`
      UPDATE pending_tasks
      SET status = ${status},
          result = ${result ? sql.json(asJson(result)) : null},
          last_error = ${error},
          completed_at = CASE WHEN ${status} = 'completed' THEN ${now} ELSE completed_at END,
          lease_token = NULL,
          lease_expires_at = NULL,
          updated_at = ${now}
      WHERE id = ${taskId}
        AND status IN ('pending', 'claimed')
      RETURNING *
    `;
    return rows[0] ?? null;
  }

  async insertOutboxEvent(
    clientId: string,
    eventType: string,
    payload: JsonObject,
    idempotencyKey: string | null,
    now: Date
  ): Promise<{ created: boolean; event: WorkerOutboxEvent }> {
    if (idempotencyKey) {
      const inserted = await sql<WorkerOutboxEvent[]>`
        INSERT INTO worker_outbox_events (client_id, idempotency_key, event_type, payload, received_at)
        VALUES (${clientId}, ${idempotencyKey}, ${eventType}, ${sql.json(asJson(payload))}, ${now})
        ON CONFLICT (client_id, idempotency_key) DO NOTHING
        RETURNING *
      `;
      if (inserted[0]) {
        return { created: true, event: inserted[0] };
      }

      const existing = await sql<WorkerOutboxEvent[]>`
        SELECT *
        FROM worker_outbox_events
        WHERE client_id = ${clientId}
          AND idempotency_key = ${idempotencyKey}
        LIMIT 1
      `;
      return { created: false, event: existing[0]! };
    }

    const rows = await sql<WorkerOutboxEvent[]>`
      INSERT INTO worker_outbox_events (client_id, event_type, payload, received_at)
      VALUES (${clientId}, ${eventType}, ${sql.json(asJson(payload))}, ${now})
      RETURNING *
    `;
    return { created: true, event: rows[0]! };
  }

  async listOutboxEvents(clientId: string, limit: number, offset: number): Promise<WorkerOutboxEvent[]> {
    return sql<WorkerOutboxEvent[]>`
      SELECT *
      FROM worker_outbox_events
      WHERE client_id = ${clientId}
      ORDER BY received_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;
  }
}

export const workerRepository: WorkerRepository = new PostgresWorkerRepository();
