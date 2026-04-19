import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { fail } from "../../errors";
import {
  createErasureRequestSchema,
  idempotencyKeyParamSchema,
  requestIdParamSchema,
  workerAckSchema,
  workerHeaderSchema,
  workerOutboxEventSchema,
} from "./schemas";
import type { ControlPlaneService } from "./service";

function validationHook(target: "json" | "header" | "param") {
  return (result: { success: boolean; error?: unknown }) => {
    if (!result.success) {
      fail({
        code: "API_VALIDATION_FAILED",
        title: "Validation failed",
        detail: `Invalid ${target} payload.`,
        status: 400,
        category: "validation",
        retryable: false,
        cause: result.error,
      });
    }
  };
}

/**
 * Creates control-plane API routes.
 */
export function createControlPlaneRouter(service: ControlPlaneService) {
  const router = new Hono();

  async function authorizeWorker(headers: { "x-client-id": string; authorization: string }) {
    const token = headers.authorization.replace(/^Bearer\s+/i, "");
    const clientId = await service.authorizeWorker(headers["x-client-id"], token);
    if (!clientId) {
      fail({
        code: "API_WORKER_AUTH_INVALID",
        title: "Invalid worker credentials",
        detail: "Worker authentication failed.",
        status: 401,
        category: "authentication",
        retryable: false,
      });
    }

    return clientId;
  }

  router.post(
    "/erasure-requests",
    zValidator("json", createErasureRequestSchema, validationHook("json")),
    async (c) => {
      const payload = c.req.valid("json");
      const created = await service.createErasureRequest(payload);
      return c.json(created, 202);
    }
  );

  router.post(
    "/erasure-requests/:idempotency_key/cancel",
    zValidator("param", idempotencyKeyParamSchema, validationHook("param")),
    async (c) => {
      const params = c.req.valid("param");
      const cancelled = await service.cancelErasureRequest(params.idempotency_key);
      if (!cancelled) {
        fail({
          code: "API_ERASURE_REQUEST_NOT_FOUND",
          title: "Erasure request not found",
          detail: `No erasure request exists for ${params.idempotency_key}.`,
          status: 404,
          category: "validation",
          retryable: false,
        });
      }

      return c.json(cancelled, 200);
    }
  );

  router.get("/worker/sync", zValidator("header", workerHeaderSchema, validationHook("header")), async (c) => {
    const header = c.req.valid("header");
    const clientId = await authorizeWorker(header);
    const synced = await service.syncWorker(header["x-client-id"], clientId);
    return c.json(synced, 200);
  });

  router.post(
    "/worker/tasks/:taskId/ack",
    zValidator("header", workerHeaderSchema, validationHook("header")),
    zValidator("json", workerAckSchema, validationHook("json")),
    async (c) => {
      const header = c.req.valid("header");
      await authorizeWorker(header);
      const result = await service.ackWorkerTask(c.req.param("taskId"), c.req.valid("json"));
      if (!result) {
        fail({
          code: "API_TASK_NOT_FOUND",
          title: "Task not found",
          detail: `Task ${c.req.param("taskId")} does not exist.`,
          status: 404,
          category: "validation",
          retryable: false,
        });
      }

      return c.json({ ok: true, ...result }, 200);
    }
  );

  router.post(
    "/worker/outbox",
    zValidator("header", workerHeaderSchema, validationHook("header")),
    zValidator("json", workerOutboxEventSchema, validationHook("json")),
    async (c) => {
      const header = c.req.valid("header");
      const clientId = await authorizeWorker(header);
      const result = await service.ingestWorkerOutbox(c.req.valid("json"), clientId);
      return c.json(result, 202);
    }
  );

  router.get("/certificates/:requestId", zValidator("param", requestIdParamSchema, validationHook("param")), async (c) => {
    const params = c.req.valid("param");
    const certificate = await service.getCertificate(params.requestId);
    if (!certificate) {
      fail({
        code: "API_CERTIFICATE_NOT_FOUND",
        title: "Certificate not found",
        detail: `Certificate ${params.requestId} does not exist.`,
        status: 404,
        category: "validation",
        retryable: false,
      });
    }

    return c.json(
      {
        request_id: certificate.request_id,
        subject_opaque_id: certificate.subject_opaque_id,
        method: certificate.method,
        legal_framework: certificate.legal_framework,
        shredded_at: certificate.shredded_at.toISOString(),
        signature: {
          algorithm: certificate.algorithm,
          key_id: certificate.key_id,
          signature_base64: certificate.signature_base64,
          public_key_spki_base64: certificate.public_key_spki_base64,
        },
      },
      200
    );
  });

  return router;
}
