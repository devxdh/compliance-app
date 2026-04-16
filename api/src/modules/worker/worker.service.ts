import { eventBus } from "../../utils/event-bus";
import type { JsonObject } from "../../types/common";
import type { TaskAckStatus } from "../../types/worker";
import type { WorkerRepository } from "./worker.repository";

export interface WorkerServiceOptions {
  longPollTimeoutMs?: number;
  leaseSeconds?: number;
}

/**
 * 
 * This is the "traffic manager" for workers. It gives workers tasks,
 * receives updates, and records outbox events.
 *
 * 
 * Application service orchestrating repository operations and long-poll eventing.
 */
export class WorkerService {
  private readonly longPollTimeoutMs: number;
  private readonly leaseSeconds: number;

  constructor(private readonly repository: WorkerRepository, options: WorkerServiceOptions = {}) {
    this.longPollTimeoutMs = options.longPollTimeoutMs ?? 25_000;
    this.leaseSeconds = options.leaseSeconds ?? 60;
  }

  async syncWorker(clientId: string): Promise<{ pending: boolean; task?: unknown }> {
    const now = new Date();
    const task = await this.repository.claimNextPendingTask(clientId, now, this.leaseSeconds);
    if (!task) {
      return { pending: false };
    }
    return { pending: true, task };
  }

  waitForTask(clientId: string): Promise<{ pending: boolean; task?: unknown }> {
    return new Promise((resolve) => {
      const channelName = `task_ready_${clientId}`;
      let settled = false;

      const cleanup = () => {
        eventBus.removeListener(channelName, onTaskReady);
        clearTimeout(timer);
      };

      const onTaskReady = (task: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve({ pending: true, task });
      };

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve({ pending: false });
      }, this.longPollTimeoutMs);

      eventBus.once(channelName, onTaskReady);
    });
  }

  async enqueueTask(clientId: string, taskType: string, payload: JsonObject) {
    const task = await this.repository.enqueueTask(clientId, taskType, payload, new Date());
    eventBus.emit(`task_ready_${clientId}`, task);
    return task;
  }

  async getTask(taskId: string) {
    return this.repository.getTask(taskId);
  }

  async ackTask(taskId: string, status: TaskAckStatus, result: JsonObject | null, error: string | null) {
    return this.repository.ackTask(taskId, status, result, error, new Date());
  }

  async receiveOutbox(clientId: string, eventType: string, payload: JsonObject, idempotencyKey: string | null) {
    return this.repository.insertOutboxEvent(clientId, eventType, payload, idempotencyKey, new Date());
  }

  async listOutboxEvents(clientId: string, limit: number, offset: number) {
    return this.repository.listOutboxEvents(clientId, limit, offset);
  }
}
