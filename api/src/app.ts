import { Hono } from "hono";
import type { Context, Next } from "hono";
import type postgres from "postgres";
import type { CoeSigner } from "./crypto/coe";
import { asApiError, serializeApiError } from "./errors";
import { ControlPlaneRepository } from "./modules/control-plane/repository";
import { createControlPlaneRouter } from "./modules/control-plane/router";
import { ControlPlaneService } from "./modules/control-plane/service";
import { getLogger, logError } from "./observability/logger";

/**
 * Dependencies required to construct the Control Plane HTTP app.
 */
export interface CreateAppOptions {
  sql: postgres.Sql;
  controlSchema: string;
  signer: CoeSigner;
  workerSharedSecret: string;
  workerClientName?: string;
  maxOutboxPayloadBytes?: number;
  taskLeaseSeconds?: number;
  webhookTimeoutMs?: number;
}

const logger = getLogger({ component: "http" });

function getRequestLogger(c: Context) {
  return logger.child({
    requestId: c.get("requestId"),
    method: c.req.method,
    path: c.req.path,
  });
}

async function requestContextMiddleware(c: Context, next: Next) {
  const requestId = c.req.header("x-request-id") ?? globalThis.crypto.randomUUID();
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
    options.taskLeaseSeconds ?? 60
  );
  const service = new ControlPlaneService({
    repository,
    signer: options.signer,
    workerSharedSecret: options.workerSharedSecret,
    workerClientName: options.workerClientName ?? "worker-1",
    maxOutboxPayloadBytes: options.maxOutboxPayloadBytes ?? 32_768,
    webhookTimeoutMs: options.webhookTimeoutMs,
  });

  app.use("*", requestContextMiddleware);

  app.onError((error, c) => {
    const normalized = logError(getRequestLogger(c), error, "HTTP request failed");
    return new Response(JSON.stringify(normalized.toProblem(c.req.path)), {
      status: normalized.status,
      headers: {
        "content-type": "application/json",
      },
    });
  });

  app.notFound((c) => {
    const problem = serializeApiError(
      asApiError(undefined, {
        code: "API_ROUTE_NOT_FOUND",
        title: "Route not found",
        detail: `No route matches ${c.req.method} ${c.req.path}.`,
        status: 404,
        category: "validation",
      }),
      c.req.path
    );
    return c.json(problem, 404);
  });

  app.get("/health", (c) => c.json({ ok: true }, 200));
  app.route("/api/v1", createControlPlaneRouter(service));

  return app;
}
