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
import { processOutbox, type OutboxEvent, type ProcessOutboxResult } from "./network/outbox";
import { getLogger, logError } from "./observability/logger";

const logger = getLogger({ component: "worker" });

/**
 * Normalized task payload accepted from Control Plane.
 */
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

/**
 * Leased task envelope returned by Control Plane sync.
 */
export interface WorkerTask {
  id: string;
  task_type: "VAULT_USER" | "NOTIFY_USER" | "SHRED_USER" | string;
  payload: WorkerTaskPayload;
}

/**
 * Control Plane sync response shape.
 */
export interface SyncTaskResponse {
  pending: boolean;
  task?: WorkerTask;
}

export type TaskExecutionResult = VaultUserResult | DispatchNoticeResult | ShredUserResult;

/**
 * Failed-task acknowledgement payload.
 */
export interface TaskFailureResult {
  error: WorkerProblemDetails;
}

export type TaskAckPayload = TaskExecutionResult | TaskFailureResult;

/**
 * Network contract required by the worker loop.
 */
export interface ApiClient {
  syncTask(): Promise<SyncTaskResponse>;
  ackTask(taskId: string, status: "completed" | "failed", result: TaskAckPayload): Promise<boolean>;
  pushOutboxEvent(event: OutboxEvent): Promise<boolean>;
}

/**
 * Dependencies required to construct the compliance worker.
 */
export interface ComplianceWorkerOptions {
  sql: postgres.Sql;
  sqlReplica?: postgres.Sql;
  secrets: WorkerSecrets;
  config: WorkerConfig;
  apiClient: ApiClient;
  mailer: MockMailer;
}

function resolveTaskSubject(task: WorkerTask): string | number {
  if (typeof task.payload.subject_opaque_id === "string" && task.payload.subject_opaque_id.trim().length > 0) {
    return task.payload.subject_opaque_id.trim();
  }

  if (typeof task.payload.userId === "number" && Number.isInteger(task.payload.userId) && task.payload.userId > 0) {
    return task.payload.userId;
  }

  fail({
    code: "DPDP_TASK_PAYLOAD_INVALID",
    title: "Invalid task payload",
    detail: `Task ${task.id} requires a non-empty subject_opaque_id or numeric userId for ${task.task_type}.`,
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
 * Orchestrates Control Plane tasks and enforces fail-closed execution semantics.
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
        return dispatchPreErasureNotice(this.sql, resolveTaskSubject(task), this.secrets, this.mailer, {
          appSchema: this.config.database.app_schema,
          engineSchema: this.config.database.engine_schema,
          rootTable: this.config.graph.root_table,
          notificationLeaseSeconds: this.config.security.notification_lease_seconds,
          noticeEmailColumn: this.config.graph.notice_email_column,
          noticeNameColumn: this.config.graph.notice_name_column,
          rootPiiColumns: this.config.graph.root_pii_columns,
          now,
        });

      case "SHRED_USER":
        return shredUser(this.sql, resolveTaskSubject(task), {
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
   * Processes at most one leased task from the Control Plane.
   *
   * Retryable/fatal errors are rethrown to preserve lease recovery behavior in the caller loop.
   *
   * @returns `true` when a task was claimed (completed or failed-ack), `false` when no task was pending.
   * @throws {WorkerError} On retryable/fatal execution failures.
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
   * Flushes the local transactional outbox to the Control Plane endpoint.
   *
   * @returns Promise resolved after one outbox processing pass.
   * @throws {WorkerError} When outbox processing detects fatal delivery/protocol errors.
   */
  async flushOutbox(): Promise<ProcessOutboxResult> {
    return processOutbox(this.sql, async (event) => this.apiClient.pushOutboxEvent(event), {
      engineSchema: this.config.database.engine_schema,
      batchSize: this.config.outbox.batch_size,
      leaseSeconds: this.config.outbox.lease_seconds,
      maxAttempts: this.config.outbox.max_attempts,
      baseBackoffMs: this.config.outbox.base_backoff_ms,
    });
  }
}
