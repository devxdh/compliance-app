import { Hono } from "hono";
import type { Context, Next } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type postgres from "postgres";
import type { CoeSigner } from "./crypto/coe";
import { handleApiError, handleNotFound } from "./http/error-handler";
import { createRateLimitMiddleware, MemoryRateLimiter } from "./http/rate-limit";
import { createWorkerRequestSigningMiddleware } from "./http/request-signing";
import { createAdminRouter } from "./modules/admin/router";
import { AdminService } from "./modules/admin/service";
import { ControlPlaneRepository } from "./modules/control-plane/repository";
import { createControlPlaneRouter } from "./modules/control-plane/router";
import { ControlPlaneService } from "./modules/control-plane/service";
import { apiMetricsMiddleware, renderApiMetrics } from "./observability/metrics";
import { getLogger } from "./observability/logger";

/**
 * Dependencies required to construct the Control Plane HTTP app.
 */
export interface CreateAppOptions {
  sql: postgres.Sql;
  controlSchema: string;
  signer: CoeSigner;
  workerSharedSecret: string;
  workerRequestSigningSecret?: string;
  workerRequestSigningMaxSkewMs?: number;
  workerClientName?: string;
  maxOutboxPayloadBytes?: number;
  taskLeaseSeconds?: number;
  taskMaxAttempts?: number;
  taskBaseBackoffMs?: number;
  webhookTimeoutMs?: number;
  adminApiToken: string;
  publicRateLimitWindowMs?: number;
  publicRateLimitMaxRequests?: number;
  now?: () => Date;
}

const logger = getLogger({ component: "http" });
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function getRequestLogger(c: Context) {
  return logger.child({
    requestId: c.get("requestId"),
    method: c.req.method,
    path: c.req.path,
  });
}

async function requestContextMiddleware(c: Context, next: Next) {
  const incomingRequestId = c.req.header("x-request-id");
  const requestId =
    incomingRequestId && REQUEST_ID_PATTERN.test(incomingRequestId)
      ? incomingRequestId
      : globalThis.crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);

  const startedAt = performance.now();
  try {
    await next();
  } finally {
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    getRequestLogger(c).info(
      {
        status: c.res.status,
        duration_ms: durationMs,
      },
      "HTTP request completed"
    );
  }
}

/**
 * Builds the Hono application for the control plane.
 *
 * Registers request context middleware, standardized error/not-found handlers,
 * health endpoint, and versioned control-plane routes.
 *
 * @param options - Application dependencies and runtime limits.
 * @returns Configured Hono application instance.
 */
export function createApp(options: CreateAppOptions) {
  const app = new Hono();
  const repository = new ControlPlaneRepository(
    options.sql,
    options.controlSchema,
    options.taskLeaseSeconds ?? 60,
    options.taskMaxAttempts ?? 10,
    options.taskBaseBackoffMs ?? 1000
  );
  const service = new ControlPlaneService({
    repository,
    signer: options.signer,
    workerSharedSecret: options.workerSharedSecret,
    workerClientName: options.workerClientName ?? "worker-1",
    maxOutboxPayloadBytes: options.maxOutboxPayloadBytes ?? 32_768,
    webhookTimeoutMs: options.webhookTimeoutMs,
    now: options.now,
  });
  const adminService = new AdminService({
    repository,
    now: options.now,
  });
  const publicRateLimiter = new MemoryRateLimiter(
    options.publicRateLimitWindowMs ?? 60_000,
    options.publicRateLimitMaxRequests ?? 60
  );

  app.use("*", secureHeaders());
  app.use("*", requestContextMiddleware);
  app.use("*", apiMetricsMiddleware);
  app.use("/api/v1/erasure-requests", createRateLimitMiddleware(publicRateLimiter));
  app.use("/api/v1/certificates/*", createRateLimitMiddleware(publicRateLimiter));
  app.use("/api/v1/admin/*", async (c, next) => {
    const authorization = c.req.header("authorization");
    if (!authorization || authorization.replace(/^Bearer\s+/i, "") !== options.adminApiToken) {
      const requestId = c.res.headers.get("x-request-id") ?? undefined;
      return new Response(
        JSON.stringify({
          type: "urn:dpdp:api:error:admin_auth_invalid",
          title: "Invalid admin credentials",
          detail: "Admin authentication failed.",
          status: 401,
          code: "API_ADMIN_AUTH_INVALID",
          category: "authentication",
          retryable: false,
          fatal: false,
          instance: c.req.path,
          request_id: requestId,
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
          },
        }
      );
    }

    await next();
  });
  app.use(
    "/api/v1/worker/*",
    createWorkerRequestSigningMiddleware(
      options.workerRequestSigningSecret,
      options.workerRequestSigningMaxSkewMs ?? 60_000
    )
  );

  app.onError(handleApiError);
  app.notFound(handleNotFound);

  app.get("/health", (c) => c.json({ ok: true }, 200));
  app.get("/ready", async (c) => {
    try {
      await options.sql`SELECT 1`;
      return c.json({ ok: true }, 200);
    } catch {
      return c.json({ ok: false }, 503);
    }
  });
  app.get("/metrics", async () =>
    new Response(await renderApiMetrics(), {
      status: 200,
      headers: {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
      },
    })
  );
  app.route("/api/v1", createControlPlaneRouter(service));
  app.route("/api/v1/admin", createAdminRouter(adminService));

  return app;
}
