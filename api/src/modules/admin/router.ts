import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { fail } from "../../errors";
import {
  adminAuditExportQuerySchema,
  adminClientNameParamSchema,
  adminCreateClientSchema,
  adminTaskIdParamSchema,
  adminUsageQuerySchema,
} from "./schemas";
import type { AdminService } from "./service";

function validationHook(target: "json" | "param" | "query") {
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
 * Creates operator-only admin routes for client management, recovery, reporting, and exports.
 *
 * @param service - Admin domain service.
 * @returns Hono router mounted under `/api/v1/admin`.
 */
export function createAdminRouter(service: AdminService) {
  const router = new Hono();

  router.get("/clients", async (c) => c.json(await service.listClients(), 200));

  router.post(
    "/clients",
    zValidator("json", adminCreateClientSchema, validationHook("json")),
    async (c) => {
      const created = await service.createClient(c.req.valid("json"));
      return c.json(created, 201);
    }
  );

  router.post(
    "/clients/:name/rotate-key",
    zValidator("param", adminClientNameParamSchema, validationHook("param")),
    async (c) => {
      const rotated = await service.rotateClientKey(c.req.valid("param").name);
      return c.json(rotated, 200);
    }
  );

  router.post(
    "/clients/:name/deactivate",
    zValidator("param", adminClientNameParamSchema, validationHook("param")),
    async (c) => c.json(await service.deactivateClient(c.req.valid("param").name), 200)
  );

  router.get("/tasks/dead-letters", async (c) => c.json(await service.listDeadLetters(), 200));

  router.post(
    "/tasks/:taskId/requeue",
    zValidator("param", adminTaskIdParamSchema, validationHook("param")),
    async (c) => c.json(await service.requeueDeadLetter(c.req.valid("param").taskId), 200)
  );

  router.get(
    "/usage",
    zValidator("query", adminUsageQuerySchema, validationHook("query")),
    async (c) => c.json(await service.summarizeUsage(c.req.valid("query")), 200)
  );

  router.get(
    "/audit/export",
    zValidator("query", adminAuditExportQuerySchema, validationHook("query")),
    async (c) => {
      const rows = await service.exportAuditLedger(c.req.valid("query"));
      const payload = rows.map((row) => JSON.stringify(row)).join("\n");
      return new Response(payload, {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
        },
      });
    }
  );

  return router;
}
