import type postgres from "postgres";
import type { WorkerConfig } from "./config/worker";
import type { WorkerSecrets } from "./engine/contracts";
import { vaultUser } from "./engine/vault";
import { dispatchPreErasureNotice, type MockMailer } from "./engine/notifier";
import { shredUser } from "./engine/shredder";
import { processOutbox } from "./network/outbox";

export interface ApiClient {
  syncTask(): Promise<{ pending: boolean; task?: any }>;
  ackTask(taskId: string, status: "completed" | "failed", result: any): Promise<boolean>;
  pushOutboxEvent(event: any): Promise<boolean>;
}

export interface ComplianceWorkerOptions {
  sql: postgres.Sql;
  secrets: WorkerSecrets;
  config: WorkerConfig;
  apiClient: ApiClient;
  mailer: MockMailer;
}

export class ComplianceWorker {
  private sql: postgres.Sql;
  private secrets: WorkerSecrets;
  private config: WorkerConfig;
  private apiClient: ApiClient;
  private mailer: MockMailer;

  constructor(options: ComplianceWorkerOptions) {
    this.sql = options.sql;
    this.secrets = options.secrets;
    this.config = options.config;
    this.apiClient = options.apiClient;
    this.mailer = options.mailer;
  }

  /**
   * Polls the Central API for a single task and processes it.
   * Returns true if a task was processed, false if the queue was empty.
   */
  async processNextTask(): Promise<boolean> {
    const { pending, task } = await this.apiClient.syncTask();
    
    if (!pending || !task) {
      return false;
    }

    try {
      let result;
      // Allow overriding 'now' from payload for deterministic testing
      const now = task.payload.now ? new Date(task.payload.now) : new Date();
      
      switch (task.task_type) {
        case "VAULT_USER":
          result = await vaultUser(this.sql, task.payload.userId, this.secrets, {
            appSchema: this.config.appSchema,
            engineSchema: this.config.engineSchema,
            retentionYears: this.config.retentionYears,
            noticeWindowHours: this.config.noticeWindowHours,
            graphMaxDepth: this.config.graphMaxDepth,
            now
          });
          break;
          
        case "NOTIFY_USER":
          result = await dispatchPreErasureNotice(this.sql, task.payload.userId, this.secrets, this.mailer, {
            appSchema: this.config.appSchema,
            engineSchema: this.config.engineSchema,
            notificationLeaseSeconds: this.config.notificationLeaseSeconds,
            now
          });
          break;
          
        case "SHRED_USER":
          result = await shredUser(this.sql, task.payload.userId, {
            appSchema: this.config.appSchema,
            engineSchema: this.config.engineSchema,
            now
          });
          break;
          
        default:
          throw new Error(`Unknown task type: ${task.task_type}`);
      }

      await this.apiClient.ackTask(task.id, "completed", result);
      return true;
      
    } catch (error) {
      console.error(`[WORKER] Failed to process task ${task.id}:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.apiClient.ackTask(task.id, "failed", { error: errorMessage });
      return true; // We processed a task, even if it failed, so return true.
    }
  }

  /**
   * Flushes the local database outbox, pushing events to the Central API.
   */
  async flushOutbox(): Promise<void> {
    await processOutbox(
      this.sql,
      async (event) => {
        return await this.apiClient.pushOutboxEvent(event);
      },
      {
        engineSchema: this.config.engineSchema,
        batchSize: this.config.outboxBatchSize,
        leaseSeconds: this.config.outboxLeaseSeconds,
        maxAttempts: this.config.outboxMaxAttempts,
        baseBackoffMs: this.config.outboxBaseBackoffMs,
      }
    );
  }
}
