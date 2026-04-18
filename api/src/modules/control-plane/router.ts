import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import {
  createErasureRequestSchema,
  workerAckSchema,
  workerHeaderSchema,
  workerOutboxEventSchema,
} from "./schemas";
import type { ControlPlaneService } from "./service";

/**
 * Creates control-plane API routes.
 */
export function createControlPlaneRouter(service: ControlPlaneService) {
  const router = new Hono();

  router.post("/erasure-requests", zValidator("json", createErasureRequestSchema), async (c) => {
    const payload = c.req.valid("json");
    const created = await service.createErasureRequest(payload);
    return c.json(created, 202);
  });

  router.get("/worker/sync", zValidator("header", workerHeaderSchema), async (c) => {
    const header = c.req.valid("header");
    const synced = await service.syncWorker(header["x-client-id"]);
    return c.json(synced, 200);
  });

  router.post("/worker/tasks/:taskId/ack", zValidator("json", workerAckSchema), async (c) => {
    const result = await service.ackWorkerTask(c.req.param("taskId"), c.req.valid("json"));
    if (!result) {
      throw new HTTPException(404, { message: "task not found" });
    }

    return c.json({ ok: true, ...result }, 200);
  });

  router.post(
    "/worker/outbox",
    zValidator("header", workerHeaderSchema),
    zValidator("json", workerOutboxEventSchema),
    async (c) => {
      try {
        const result = await service.ingestWorkerOutbox(c.req.valid("json"));
        return c.json(result, 202);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid outbox event";
        throw new HTTPException(400, { message });
      }
    }
  );

  router.get("/certificates/:requestId", async (c) => {
    const certificate = await service.getCertificate(c.req.param("requestId"));
    if (!certificate) {
      throw new HTTPException(404, { message: "certificate not found" });
    }

    return c.json(
      {
        requestId: certificate.request_id,
        targetHash: certificate.target_hash,
        method: certificate.method,
        legalFramework: certificate.legal_framework,
        shreddedAt: certificate.shredded_at.toISOString(),
        signature: {
          algorithm: certificate.algorithm,
          keyId: certificate.key_id,
          signatureBase64: certificate.signature_base64,
          publicKeySpkiBase64: certificate.public_key_spki_base64,
        },
      },
      200
    );
  });

  return router;
}

