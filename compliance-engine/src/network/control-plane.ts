import { z } from "zod";
import { asWorkerError, workerError } from "../errors";
import { getLogger } from "../observability/logger";
import type { ApiClient, SyncTaskResponse, TaskAckPayload } from "../worker";

const logger = getLogger({ component: "control-plane" });

const isoDateStringSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "Expected an ISO-8601 timestamp.",
});

const taskPayloadBaseSchema = z
  .object({
    request_id: z.string().uuid().optional(),
    subject_opaque_id: z.string().min(1).optional(),
    idempotency_key: z.string().uuid().optional(),
    trigger_source: z
      .enum(["USER_CONSENT_WITHDRAWAL", "PURPOSE_FULFILLED", "ADMIN_PURGE"])
      .optional(),
    actor_opaque_id: z.string().min(1).optional(),
    legal_framework: z.string().min(1).optional(),
    request_timestamp: isoDateStringSchema.optional(),
    tenant_id: z.string().min(1).optional(),
    cooldown_days: z.number().int().min(0).optional(),
    shadow_mode: z.boolean().optional(),
    webhook_url: z.string().url().optional(),
    userId: z.number().int().positive().optional(),
    now: isoDateStringSchema.optional(),
  })
  .strict();

const syncTaskSchema = z.discriminatedUnion("task_type", [
  z
    .object({
      id: z.string().min(1),
      task_type: z.literal("VAULT_USER"),
      payload: taskPayloadBaseSchema.extend({
        shadowMode: z.boolean().optional(),
      }).superRefine((value, ctx) => {
        if (!value.subject_opaque_id && value.userId === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "VAULT_USER payload must include subject_opaque_id or userId.",
            path: ["subject_opaque_id"],
          });
        }
      }),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      task_type: z.literal("NOTIFY_USER"),
      payload: taskPayloadBaseSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      task_type: z.literal("SHRED_USER"),
      payload: taskPayloadBaseSchema,
    })
    .strict(),
]);

const syncResponseSchema = z.union([
  z
    .object({
      pending: z.literal(false),
    })
    .strict(),
  z
    .object({
      pending: z.literal(true),
      task: syncTaskSchema,
    })
    .strict(),
]);

/**
 * HTTP endpoints and credentials required to communicate with the Control Plane.
 */
export interface ControlPlaneApiClientOptions {
  syncUrl: string;
  ackBaseUrl: string;
  workerAuthHeaders: {
    "x-client-id": string;
    authorization: string;
  };
  pushOutboxEvent: ApiClient["pushOutboxEvent"];
  timeoutMs?: number;
}

function buildControlPlaneHttpError(
  operation: "sync" | "ack",
  status: number,
  context: Record<string, unknown> = {}
) {
  if (status === 429 || status >= 500) {
    return workerError({
      code: "DPDP_CONTROL_PLANE_UNAVAILABLE",
      title: "Control Plane unavailable",
      detail: `Control Plane ${operation} request failed with HTTP ${status}.`,
      category: "network",
      retryable: true,
      context: {
        operation,
        status,
        ...context,
      },
    });
  }

  if (status === 401 || status === 403) {
    return workerError({
      code: "DPDP_CONTROL_PLANE_AUTH_REJECTED",
      title: "Control Plane authentication rejected",
      detail: `Control Plane ${operation} request was rejected with HTTP ${status}.`,
      category: "configuration",
      retryable: false,
      fatal: true,
      context: {
        operation,
        status,
        ...context,
      },
    });
  }

  return workerError({
    code: "DPDP_CONTROL_PLANE_PROTOCOL_REJECTED",
    title: "Control Plane protocol rejected",
    detail: `Control Plane ${operation} request failed with HTTP ${status}.`,
    category: "external",
    retryable: false,
    fatal: true,
    context: {
      operation,
      status,
      ...context,
    },
  });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error) {
    throw asWorkerError(error, {
      code: "DPDP_CONTROL_PLANE_REQUEST_FAILED",
      title: "Control Plane request failed",
      detail: `Failed to reach ${url}.`,
      category: "network",
      retryable: true,
      context: {
        url,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds a strict Control Plane client that validates response payloads before task execution.
 *
 * @param options - Control Plane endpoints, worker auth headers, outbox push transport, and timeout.
 * @returns API client implementation consumed by `ComplianceWorker`.
 * @throws {WorkerError} For transport failures, auth failures, or protocol/schema violations.
 */
export function createControlPlaneApiClient(options: ControlPlaneApiClientOptions): ApiClient {
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async syncTask(): Promise<SyncTaskResponse> {
      const response = await fetchWithTimeout(
        options.syncUrl,
        {
          headers: options.workerAuthHeaders,
        },
        timeoutMs
      );

      if (response.status === 204) {
        return { pending: false };
      }

      if (!response.ok) {
        throw buildControlPlaneHttpError("sync", response.status, { url: options.syncUrl });
      }

      let parsedBody: unknown;
      try {
        parsedBody = await response.json();
        return syncResponseSchema.parse(parsedBody);
      } catch (error) {
        throw asWorkerError(error, {
          code: "DPDP_CONTROL_PLANE_RESPONSE_INVALID",
          title: "Invalid Control Plane response",
          detail: "Control Plane sync response failed schema validation.",
          category: "external",
          retryable: false,
          fatal: true,
          context: {
            url: options.syncUrl,
          },
        });
      }
    },

    async ackTask(taskId: string, status: "completed" | "failed", result: TaskAckPayload): Promise<boolean> {
      const url = `${options.ackBaseUrl}/${taskId}/ack`;
      const response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...options.workerAuthHeaders,
          },
          body: JSON.stringify({ status, result }),
        },
        timeoutMs
      );

      if (!response.ok) {
        throw buildControlPlaneHttpError("ack", response.status, {
          url,
          taskId,
          status,
        });
      }

      logger.debug({ taskId, status }, "Control Plane acknowledged task");
      return true;
    },

    pushOutboxEvent: options.pushOutboxEvent,
  };
}
