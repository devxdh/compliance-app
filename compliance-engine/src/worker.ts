import type postgres from "postgres";
import type { WorkerConfig } from "./config/worker";
import type {
  DispatchNoticeResult,
  ShredUserResult,
  VaultUserResult,
  WorkerSecrets,
} from "./engine/contracts";
import { dispatchPreErasureNotice, type MockMailer } from "./engine/notifier";
import { shredUser } from "./engine/shredder";
import { vaultUser } from "./engine/vault";
import { fail, serializeWorkerError, workerError, type WorkerProblemDetails } from "./errors";
import { processOutbox, type OutboxEvent } from "./network/outbox";
import { getLogger, logError } from "./observability/logger";

const logger = getLogger({ component: "worker" });

export interface WorkerTaskPayload {
  request_id?: string;
  subject_opaque_id?: string;
  idempotency_key?: string;
  trigger_source?: "USER_CONSENT_WITHDRAWAL" | "PURPOSE_FULFILLED" | "ADMIN_PURGE";
  actor_opaque_id?: string;
  legal_framework?: string;
  request_timestamp?: string;
  tenant_id?: string;
  cooldown_days?: number;
  shadow_mode?: boolean;
  webhook_url?: string;
  userId?: number;
  now?: string;
  shadowMode?: boolean;
}

export interface WorkerTask {
  id: string;
  task_type: "VAULT_USER" | "NOTIFY_USER" | "SHRED_USER" | string;
  payload: WorkerTaskPayload;
}

export interface SyncTaskResponse {
  pending: boolean;
  task?: WorkerTask;
}

export type TaskExecutionResult = VaultUserResult | DispatchNoticeResult | ShredUserResult;

export interface TaskFailureResult {
  error: WorkerProblemDetails;
}

export type TaskAckPayload = TaskExecutionResult | TaskFailureResult;

export interface ApiClient {
  syncTask(): Promise<SyncTaskResponse>;
  ackTask(taskId: string, status: "completed" | "failed", result: TaskAckPayload): Promise<boolean>;
  pushOutboxEvent(event: OutboxEvent): Promise<boolean>;
}

export interface ComplianceWorkerOptions {
  sql: postgres.Sql;
  sqlReplica?: postgres.Sql;
  secrets: WorkerSecrets;
  config: WorkerConfig;
  apiClient: ApiClient;
  mailer: MockMailer;
}

function resolveNumericTaskSubject(task: WorkerTask): number {
  if (typeof task.payload.userId === "number" && Number.isInteger(task.payload.userId) && task.payload.userId > 0) {
    return task.payload.userId;
  }

  const parsed = Number(task.payload.subject_opaque_id);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  fail({
    code: "DPDP_TASK_PAYLOAD_INVALID",
    title: "Invalid task payload",
    detail: `Task ${task.id} requires a numeric user identifier for ${task.task_type}.`,
    category: "validation",
    retryable: false,
    context: { taskId: task.id, taskType: task.task_type },
  });
}

async function acknowledgeTask(
  apiClient: ApiClient,
  taskId: string,
  status: "completed" | "failed",
  result: TaskAckPayload
) {
  const acknowledged = await apiClient.ackTask(taskId, status, result);
  if (!acknowledged) {
    throw workerError({
      code: "DPDP_TASK_ACK_FAILED",
      title: "Task acknowledgement failed",
      detail: `Control Plane did not acknowledge task ${taskId}.`,
      category: "network",
      retryable: true,
      context: {
        taskId,
        status,
      },
    });
  }
}

/**
 * Orchestrates validated tasks from the Control Plane and keeps failure handling fail-closed.
 */
export class ComplianceWorker {
  private readonly sql: postgres.Sql;
  private readonly sqlReplica?: postgres.Sql;
  private readonly secrets: WorkerSecrets;
  private readonly config: WorkerConfig;
  private readonly apiClient: ApiClient;
  private readonly mailer: MockMailer;

  constructor(options: ComplianceWorkerOptions) {
    this.sql = options.sql;
    this.sqlReplica = options.sqlReplica;
    this.secrets = options.secrets;
    this.config = options.config;
    this.apiClient = options.apiClient;
    this.mailer = options.mailer;
  }

  private async executeTask(task: WorkerTask, now: Date): Promise<TaskExecutionResult> {
    switch (task.task_type) {
      case "VAULT_USER":
        return vaultUser(
          this.sql,
          task.payload.subject_opaque_id ?? task.payload.userId ?? "",
          this.secrets,
          {
          appSchema: this.config.database.app_schema,
          engineSchema: this.config.database.engine_schema,
          defaultRetentionYears: this.config.compliance_policy.default_retention_years,
          noticeWindowHours: this.config.compliance_policy.notice_window_hours,
          graphMaxDepth: this.config.graph.max_depth,
          rootTable: this.config.graph.root_table,
          rootIdColumn: this.config.graph.root_id_column,
          rootPiiColumns: this.config.graph.root_pii_columns,
          satelliteTargets: this.config.satellite_targets,
          retentionRules: this.config.compliance_policy.retention_rules,
          tenantId: task.payload.tenant_id,
          requestId: task.payload.request_id,
          subjectOpaqueId: task.payload.subject_opaque_id,
          triggerSource: task.payload.trigger_source,
          actorOpaqueId: task.payload.actor_opaque_id,
          legalFramework: task.payload.legal_framework,
          requestTimestamp: task.payload.request_timestamp,
          shadowMode: task.payload.shadow_mode ?? task.payload.shadowMode,
          sqlReplica: this.sqlReplica,
          now,
          }
        );

      case "NOTIFY_USER":
        return dispatchPreErasureNotice(this.sql, resolveNumericTaskSubject(task), this.secrets, this.mailer, {
          appSchema: this.config.database.app_schema,
          engineSchema: this.config.database.engine_schema,
          rootTable: this.config.graph.root_table,
          notificationLeaseSeconds: this.config.security.notification_lease_seconds,
          now,
        });

      case "SHRED_USER":
        return shredUser(this.sql, resolveNumericTaskSubject(task), {
          appSchema: this.config.database.app_schema,
          engineSchema: this.config.database.engine_schema,
          rootTable: this.config.graph.root_table,
          now,
        });

      default:
        fail({
          code: "DPDP_TASK_TYPE_UNKNOWN",
          title: "Unknown task type",
          detail: `Unknown task type: ${task.task_type}.`,
          category: "validation",
          retryable: false,
          context: {
            taskId: task.id,
            taskType: task.task_type,
          },
        });
    }
  }

  /**
   * Processes one task. Retryable and fatal errors are rethrown so the lease can recover safely.
   */
  async processNextTask(): Promise<boolean> {
    const { pending, task } = await this.apiClient.syncTask();
    if (!pending || !task) {
      return false;
    }

    const taskLogger = logger.child({
      taskId: task.id,
      taskType: task.task_type,
    });

    try {
      const now = task.payload.now ? new Date(task.payload.now) : new Date();
      const result = await this.executeTask(task, now);
      await acknowledgeTask(this.apiClient, task.id, "completed", result);
      taskLogger.info({ action: result.action, userHash: result.userHash }, "Task completed");
      return true;
    } catch (error) {
      const normalized = logError(taskLogger, error, "Task execution failed");

      if (normalized.fatal || normalized.retryable) {
        throw normalized;
      }

      await acknowledgeTask(this.apiClient, task.id, "failed", {
        error: serializeWorkerError(normalized, `task:${task.id}`),
      });
      taskLogger.warn({ code: normalized.code }, "Task acknowledged as failed");
      return true;
    }
  }

  /**
   * Flushes the local outbox through the injected Control Plane dispatcher.
   */
  async flushOutbox(): Promise<void> {
    await processOutbox(this.sql, async (event) => this.apiClient.pushOutboxEvent(event), {
      engineSchema: this.config.database.engine_schema,
      batchSize: this.config.outbox.batch_size,
      leaseSeconds: this.config.outbox.lease_seconds,
      maxAttempts: this.config.outbox.max_attempts,
      baseBackoffMs: this.config.outbox.base_backoff_ms,
    });
  }
}
