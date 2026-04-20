import { Hono } from "hono";
import type { Context, Next } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type postgres from "postgres";
import type { CoeSigner } from "./crypto/coe";
import { handleApiError, handleNotFound } from "./http/error-handler";
import { ControlPlaneRepository } from "./modules/control-plane/repository";
import { createControlPlaneRouter } from "./modules/control-plane/router";
import { ControlPlaneService } from "./modules/control-plane/service";
import { getLogger } from "./observability/logger";

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
  taskMaxAttempts?: number;
  taskBaseBackoffMs?: number;
  webhookTimeoutMs?: number;
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

  app.use("*", secureHeaders());
  app.use("*", requestContextMiddleware);

  app.onError(handleApiError);
  app.notFound(handleNotFound);

  app.get("/health", (c) => c.json({ ok: true }, 200));
  app.route("/api/v1", createControlPlaneRouter(service));

  return app;
}
