import { z } from "zod";

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

export type AdminCreateClientInput = z.infer<typeof adminCreateClientSchema>;
export type AdminUsageQueryInput = z.infer<typeof adminUsageQuerySchema>;
export type AdminAuditExportQueryInput = z.infer<typeof adminAuditExportQuerySchema>;
