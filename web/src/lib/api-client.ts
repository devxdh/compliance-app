import "server-only";
import { z } from "zod";
import {
  auditLedgerRowSchema,
  clientSchema,
  clientTokenResponseSchema,
  deadLetterTaskSchema,
  erasureJobSchema,
  erasureRequestStatusSchema,
  requeueTaskResponseSchema,
  usageSummarySchema,
  type AuditLedgerRow,
  type ClientTokenResponse,
  type DeadLetterTask,
  type ErasureJob,
  type ErasureRequestStatus,
  type RequeueTaskResponse,
  type UsageSummary,
  type WorkerClient,
} from "@/lib/api-schemas";

export interface ApiClientState {
  configured: boolean;
  reason?: string;
}

export interface ControlPlaneSnapshot {
  state: ApiClientState;
  usage: UsageSummary[];
  clients: WorkerClient[];
  deadLetters: DeadLetterTask[];
  auditLedger: AuditLedgerRow[];
  erasureRequests: ErasureJob[];
}

const usageListSchema = z.array(usageSummarySchema);
const clientListSchema = z.array(clientSchema);
const deadLetterListSchema = z.array(deadLetterTaskSchema);
const auditLedgerListSchema = z.array(auditLedgerRowSchema);
const erasureJobListSchema = z.array(erasureJobSchema);

function getApiConfig(): { baseUrl: string; token: string } | null {
  const baseUrl = process.env.AVANTII_API_BASE_URL ?? process.env.CONTROL_PLANE_API_URL ?? "http://localhost:3000";
  const token = process.env.ADMIN_API_TOKEN;

  if (!token) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token,
  };
}

/**
 * Builds a browser-safe certificate download URL without exposing admin credentials.
 *
 * @param requestId - Erasure request UUID.
 * @returns Absolute Control Plane PDF route.
 */
export function getCertificateDownloadUrl(requestId: string): string {
  const baseUrl =
    process.env.NEXT_PUBLIC_AVANTII_API_BASE_URL ??
    process.env.AVANTII_API_BASE_URL ??
    process.env.CONTROL_PLANE_API_URL ??
    "http://localhost:3000";

  return `${baseUrl.replace(/\/+$/, "")}/api/v1/certificates/${encodeURIComponent(requestId)}/download`;
}

/**
 * Reports whether the server-side admin API token is configured.
 *
 * @returns `true` when the BFF can call protected admin endpoints.
 */
export function isControlPlaneConfigured(): boolean {
  return getApiConfig() !== null;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }

  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

async function requestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {}
): Promise<T> {
  const config = getApiConfig();
  if (!config) {
    throw new Error("ADMIN_API_TOKEN is not configured.");
  }

  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.token}`,
      ...init.headers,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Control Plane request failed: ${response.status} ${response.statusText}`);
  }

  return schema.parse(await response.json());
}

/**
 * Fetches aggregated usage rows from the Control Plane admin API.
 *
 * @param filters - Optional client and time filters accepted by `/api/v1/admin/usage`.
 * @returns Usage totals grouped by client and event type.
 */
export async function getUsageSummary(filters: {
  clientName?: string;
  since?: string;
  until?: string;
} = {}): Promise<UsageSummary[]> {
  return requestJson(
    `/api/v1/admin/usage${buildQuery({
      client_name: filters.clientName,
      since: filters.since,
      until: filters.until,
    })}`,
    usageListSchema
  );
}

/**
 * Fetches worker clients and burn-in metadata.
 *
 * @returns Registered worker sidecars known to the Control Plane.
 */
export async function getWorkerClients(): Promise<WorkerClient[]> {
  return requestJson("/api/v1/admin/clients", clientListSchema);
}

/**
 * Fetches dead-lettered Control Plane tasks requiring operator action.
 *
 * @returns Failed task rows safe for dashboard rendering.
 */
export async function getDeadLetters(): Promise<DeadLetterTask[]> {
  return requestJson("/api/v1/admin/tasks/dead-letters", deadLetterListSchema);
}

/**
 * Fetches erasure lifecycle rows for dashboard tables.
 *
 * @param filters - Optional status and pagination filters.
 * @returns Erasure jobs newest first.
 */
export async function getErasureRequests(filters: {
  status?: ErasureRequestStatus;
  limit?: number;
  offset?: number;
} = {}): Promise<ErasureJob[]> {
  return requestJson(
    `/api/v1/admin/erasure-requests${buildQuery({
      status: filters.status ? erasureRequestStatusSchema.parse(filters.status) : undefined,
      limit: filters.limit,
      offset: filters.offset,
    })}`,
    erasureJobListSchema
  );
}

/**
 * Fetches one erasure lifecycle aggregate.
 *
 * @param requestId - Erasure request UUID.
 * @returns Matching erasure job.
 */
export async function getErasureRequest(requestId: string): Promise<ErasureJob> {
  return requestJson(`/api/v1/admin/erasure-requests/${encodeURIComponent(requestId)}`, erasureJobSchema);
}

/**
 * Streams the admin audit export and parses each NDJSON WORM ledger row.
 *
 * @param filters - Optional client and ledger sequence filters.
 * @returns Ordered audit ledger rows.
 */
export async function getAuditLedger(filters: {
  clientName?: string;
  afterLedgerSeq?: number;
} = {}): Promise<AuditLedgerRow[]> {
  const config = getApiConfig();
  if (!config) {
    throw new Error("ADMIN_API_TOKEN is not configured.");
  }

  const response = await fetch(
    `${config.baseUrl}/api/v1/admin/audit/export${buildQuery({
      client_name: filters.clientName,
      after_ledger_seq: filters.afterLedgerSeq,
    })}`,
    {
      headers: {
        accept: "application/x-ndjson",
        authorization: `Bearer ${config.token}`,
      },
      cache: "no-store",
    }
  );

  if (!response.ok) {
    throw new Error(`Control Plane audit export failed: ${response.status} ${response.statusText}`);
  }

  const rows = (await response.text())
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsedLine: unknown = JSON.parse(line);
      return auditLedgerRowSchema.parse(parsedLine);
    });

  return auditLedgerListSchema.parse(rows);
}

/**
 * Requeues a dead-letter task through the server-side BFF boundary.
 *
 * @param taskId - Dead-letter task UUID.
 * @returns Updated task row returned by the Control Plane.
 */
export async function requeueDeadLetterTask(taskId: string): Promise<RequeueTaskResponse> {
  return requestJson(
    `/api/v1/admin/tasks/${encodeURIComponent(taskId)}/requeue`,
    requeueTaskResponseSchema,
    { method: "POST" }
  );
}

/**
 * Rotates a worker client's bearer token through the server-only BFF boundary.
 *
 * @param name - Stable worker client name.
 * @returns Updated client metadata and one-time raw token from the Control Plane.
 */
export async function rotateWorkerClientKey(name: string): Promise<ClientTokenResponse> {
  return requestJson(
    `/api/v1/admin/clients/${encodeURIComponent(name)}/rotate-key`,
    clientTokenResponseSchema,
    { method: "POST" }
  );
}

/**
 * Creates a worker client and returns its one-time raw bearer token.
 *
 * @param input - Stable client name and optional display name.
 * @returns Persisted client metadata and one-time raw token.
 */
export async function createWorkerClient(input: {
  name: string;
  displayName?: string;
}): Promise<ClientTokenResponse> {
  return requestJson("/api/v1/admin/clients", clientTokenResponseSchema, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: input.name,
      display_name: input.displayName || undefined,
    }),
  });
}

/**
 * Deactivates a worker client without deleting its audit lineage.
 *
 * @param name - Stable worker client name.
 * @returns Updated client metadata.
 */
export async function deactivateWorkerClient(name: string): Promise<WorkerClient> {
  return requestJson(
    `/api/v1/admin/clients/${encodeURIComponent(name)}/deactivate`,
    clientSchema,
    { method: "POST" }
  );
}

/**
 * Loads the dashboard's initial server-side data without manufacturing records.
 *
 * @returns Control Plane data, or empty arrays with a configuration/error reason.
 */
export async function getControlPlaneSnapshot(): Promise<ControlPlaneSnapshot> {
  const config = getApiConfig();
  if (!config) {
    return {
      state: {
        configured: false,
        reason: "ADMIN_API_TOKEN is missing. Configure the BFF before viewing live Control Plane data.",
      },
      usage: [],
      clients: [],
      deadLetters: [],
      auditLedger: [],
      erasureRequests: [],
    };
  }

  try {
    const [usage, clients, deadLetters, auditLedger, erasureRequests] = await Promise.all([
      getUsageSummary(),
      getWorkerClients(),
      getDeadLetters(),
      getAuditLedger(),
      getErasureRequests(),
    ]);

    return {
      state: { configured: true },
      usage,
      clients,
      deadLetters,
      auditLedger,
      erasureRequests,
    };
  } catch (error) {
    return {
      state: {
        configured: false,
        reason: error instanceof Error ? error.message : "Control Plane request failed.",
      },
      usage: [],
      clients: [],
      deadLetters: [],
      auditLedger: [],
      erasureRequests: [],
    };
  }
}
