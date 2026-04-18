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

  async function authorizeWorker(headers: { "x-client-id": string; authorization: string }) {
    const token = headers.authorization.replace(/^Bearer\s+/i, "");
    const clientId = await service.authorizeWorker(headers["x-client-id"], token);
    if (!clientId) {
      throw new HTTPException(401, { message: "invalid worker credentials" });
    }

    return clientId;
  }

  router.post("/erasure-requests", zValidator("json", createErasureRequestSchema), async (c) => {
    const payload = c.req.valid("json");
    const created = await service.createErasureRequest(payload);
    return c.json(created, 202);
  });

  router.get("/worker/sync", zValidator("header", workerHeaderSchema), async (c) => {
    const header = c.req.valid("header");
    const clientId = await authorizeWorker(header);
    const synced = await service.syncWorker(header["x-client-id"], clientId);
    return c.json(synced, 200);
  });

  router.post(
    "/worker/tasks/:taskId/ack",
    zValidator("header", workerHeaderSchema),
    zValidator("json", workerAckSchema),
    async (c) => {
      const header = c.req.valid("header");
      await authorizeWorker(header);
      const result = await service.ackWorkerTask(c.req.param("taskId"), c.req.valid("json"));
      if (!result) {
        throw new HTTPException(404, { message: "task not found" });
      }

      return c.json({ ok: true, ...result }, 200);
    }
  );

  router.post(
    "/worker/outbox",
    zValidator("header", workerHeaderSchema),
    zValidator("json", workerOutboxEventSchema),
    async (c) => {
      try {
        const header = c.req.valid("header");
        const clientId = await authorizeWorker(header);
        const result = await service.ingestWorkerOutbox(c.req.valid("json"), clientId);
        return c.json(result, 202);
      } catch (error) {
        if (error instanceof HTTPException) {
          throw error;
        }
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
