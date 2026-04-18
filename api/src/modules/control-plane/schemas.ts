import { z } from "zod";

const hash64 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be a 64-character hex digest")
  .transform((value) => value.toLowerCase());

export const createErasureRequestSchema = z
  .object({
    clientId: z.string().min(1),
    targetHash: hash64,
    legalBasis: z.enum(["DPDP_SEC_8_7", "CONSENT_WITHDRAWAL", "PURPOSE_EXHAUSTED"]),
    retentionYears: z.number().int().min(1).max(8),
    rootUserId: z.number().int().min(1).optional(),
  })
  .strict();

export const workerAckSchema = z
  .object({
    status: z.enum(["completed", "failed"]),
    result: z.unknown(),
  })
  .strict();

export const workerOutboxEventSchema = z
  .object({
    idempotencyKey: z.string().min(1),
    requestId: z.string().min(1),
    targetHash: hash64,
    eventType: z.enum(["USER_VAULTED", "NOTIFICATION_SENT", "SHRED_SUCCESS"]),
    payload: z.record(z.string(), z.unknown()).or(z.array(z.unknown())).or(z.string()).or(z.number()).or(z.boolean()).or(z.null()),
    previousHash: z
      .string()
      .refine(
        (value) => value === "GENESIS" || /^[0-9a-fA-F]{64}$/.test(value),
        "must be GENESIS or a 64-character hex digest"
      )
      .transform((value) => (value === "GENESIS" ? value : value.toLowerCase())),
    currentHash: z.string().regex(/^[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase()),
    eventTimestamp: z.iso.datetime(),
  })
  .strict();

export const workerHeaderSchema = z.object({
  "x-client-id": z.string().min(1),
  authorization: z.string().regex(/^Bearer\s+\S+$/),
});

export type CreateErasureRequestInput = z.infer<typeof createErasureRequestSchema>;
export type WorkerAckInput = z.infer<typeof workerAckSchema>;
export type WorkerOutboxEventInput = z.infer<typeof workerOutboxEventSchema>;
