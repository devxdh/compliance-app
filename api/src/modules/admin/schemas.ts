import { z } from "zod";
import { erasureRequestStatusSchema } from "../control-plane/schemas";

export const adminCreateClientSchema = z
  .object({
    name: z.string().trim().min(1),
    display_name: z.string().trim().min(1).optional(),
  })
  .strict();

export const adminClientNameParamSchema = z
  .object({
    name: z.string().trim().min(1),
  })
  .strict();

export const adminTaskIdParamSchema = z
  .object({
    taskId: z.uuid(),
  })
  .strict();

export const adminRequestIdParamSchema = z
  .object({
    requestId: z.uuid(),
  })
  .strict();

export const adminUsageQuerySchema = z
  .object({
    client_name: z.string().trim().min(1).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const adminAuditExportQuerySchema = z
  .object({
    client_name: z.string().trim().min(1).optional(),
    after_ledger_seq: z.coerce.number().int().positive().optional(),
  })
  .strict();

export const adminErasureRequestQuerySchema = z
  .object({
    status: erasureRequestStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type AdminCreateClientInput = z.infer<typeof adminCreateClientSchema>;
export type AdminUsageQueryInput = z.infer<typeof adminUsageQuerySchema>;
export type AdminAuditExportQueryInput = z.infer<typeof adminAuditExportQuerySchema>;
export type AdminErasureRequestQueryInput = z.infer<typeof adminErasureRequestQuerySchema>;
