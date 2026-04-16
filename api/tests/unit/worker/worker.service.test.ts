import { describe, expect, it } from "vitest";
import { WorkerService } from "../../../src/modules/worker/worker.service";
import type { WorkerRepository } from "../../../src/modules/worker/worker.repository";
import type { JsonObject } from "../../../src/types/common";
import type { WorkerOutboxEvent, WorkerTask } from "../../../src/types/worker";

class InMemoryWorkerRepository implements WorkerRepository {
  private tasks: WorkerTask[] = [];
  private outbox: WorkerOutboxEvent[] = [];

  async claimNextPendingTask(clientId: string): Promise<WorkerTask | null> {
    const task = this.tasks.find((t) => t.client_id === clientId && t.status === "pending");
    if (!task) {
      return null;
    }
    task.status = "claimed";
    return task;
  }

  async enqueueTask(clientId: string, taskType: string, payload: JsonObject, now: Date): Promise<WorkerTask> {
    const task: WorkerTask = {
      id: crypto.randomUUID(),
      client_id: clientId,
      task_type: taskType,
      payload,
      status: "pending",
      lease_token: null,
      lease_expires_at: null,
      claimed_at: null,
      completed_at: null,
      attempt_count: 0,
      result: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    this.tasks.push(task);
    return task;
  }

  async getTask(taskId: string): Promise<WorkerTask | null> {
    return this.tasks.find((task) => task.id === taskId) ?? null;
  }

  async ackTask(
    taskId: string,
    status: "completed" | "failed" | "cancelled",
    result: JsonObject | null,
    error: string | null,
    now: Date
  ): Promise<WorkerTask | null> {
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task || (task.status !== "pending" && task.status !== "claimed")) {
      return null;
    }
    task.status = status;
    task.result = result;
    task.last_error = error;
    task.updated_at = now;
    return task;
  }

  async insertOutboxEvent(
    clientId: string,
    eventType: string,
    payload: JsonObject,
    idempotencyKey: string | null,
    now: Date
  ): Promise<{ created: boolean; event: WorkerOutboxEvent }> {
    if (idempotencyKey) {
      const existing = this.outbox.find((event) => event.client_id === clientId && event.idempotency_key === idempotencyKey);
      if (existing) {
        return { created: false, event: existing };
      }
    }

    const event: WorkerOutboxEvent = {
      id: crypto.randomUUID(),
      client_id: clientId,
      idempotency_key: idempotencyKey,
      event_type: eventType,
      payload,
      received_at: now,
      processed_at: null,
    };
    this.outbox.push(event);
    return { created: true, event };
  }

  async listOutboxEvents(clientId: string): Promise<WorkerOutboxEvent[]> {
    return this.outbox.filter((event) => event.client_id === clientId);
  }
}

describe("WorkerService", () => {
  it("creates and claims worker tasks", async () => {
    const repo = new InMemoryWorkerRepository();
    const service = new WorkerService(repo, { longPollTimeoutMs: 10 });

    await service.enqueueTask("client-a", "VAULT_USER", { userId: 1 });
    const sync = await service.syncWorker("client-a");

    expect(sync.pending).toBe(true);
    expect((sync.task as WorkerTask).task_type).toBe("VAULT_USER");
  });

  it("acks task completion", async () => {
    const repo = new InMemoryWorkerRepository();
    const service = new WorkerService(repo, { longPollTimeoutMs: 10 });

    const task = await service.enqueueTask("client-a", "SHRED_USER", { userId: 7 });
    const acked = await service.ackTask(task.id, "completed", { ok: true }, null);

    expect(acked?.status).toBe("completed");
    expect(acked?.result).toEqual({ ok: true });
  });

  it("deduplicates outbox events by idempotency key", async () => {
    const repo = new InMemoryWorkerRepository();
    const service = new WorkerService(repo, { longPollTimeoutMs: 10 });

    const first = await service.receiveOutbox("client-a", "USER_VAULTED", { userHash: "abc" }, "key-1");
    const second = await service.receiveOutbox("client-a", "USER_VAULTED", { userHash: "abc" }, "key-1");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
  });
});
