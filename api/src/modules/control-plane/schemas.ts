import { z } from "zod";

const isoDateTime = z.string().datetime();

export const erasureTriggerSourceSchema = z.enum([
  "USER_CONSENT_WITHDRAWAL",
  "PURPOSE_FULFILLED",
  "ADMIN_PURGE",
]);

/**
 * Lifecycle states of an erasure request managed by the Control Plane.
 */
export const erasureRequestStatusSchema = z.enum([
  "WAITING_COOLDOWN",
  "EXECUTING",
  "VAULTED",
  "NOTICE_SENT",
  "SHREDDED",
  "FAILED",
  "CANCELLED",
]);

export const outboxEventTypeSchema = z.enum([
  "USER_VAULTED",
  "NOTIFICATION_SENT",
  "SHRED_SUCCESS",
  "USER_HARD_DELETED",
]);

/**
 * Enterprise ingestion schema for `POST /api/v1/erasure-requests`.
 */
export const createErasureRequestSchema = z
  .object({
    subject_opaque_id: z.string().min(1),
    idempotency_key: z.string().uuid(),
    trigger_source: erasureTriggerSourceSchema,
    actor_opaque_id: z.string().min(1),
    legal_framework: z.string().min(1),
    request_timestamp: isoDateTime,
    tenant_id: z.string().min(1).optional(),
    cooldown_days: z.number().int().min(0).default(30),
    shadow_mode: z.boolean().default(false),
    webhook_url: z.string().url().optional(),
  })
  .strict();

/**
 * Worker acknowledgement payload for task completion/failure.
 */
export const workerAckSchema = z
  .object({
    status: z.enum(["completed", "failed"]),
    result: z.unknown(),
  })
  .strict();

/**
 * Worker outbox envelope validated before WORM ledger ingestion.
 */
export const workerOutboxEventSchema = z
  .object({
    idempotency_key: z.string().min(1),
    request_id: z.string().uuid(),
    subject_opaque_id: z.string().min(1),
    event_type: outboxEventTypeSchema,
    payload: z.record(z.string(), z.unknown()),
    previous_hash: z
      .string()
      .refine(
        (value) => value === "GENESIS" || /^[0-9a-f]{64}$/i.test(value),
        "must be GENESIS or a 64-character hex digest"
      )
      .transform((value) => (value === "GENESIS" ? value : value.toLowerCase())),
    current_hash: z.string().regex(/^[0-9a-f]{64}$/i).transform((value) => value.toLowerCase()),
    event_timestamp: isoDateTime,
  })
  .strict();

export const workerHeaderSchema = z
  .object({
    "x-client-id": z.string().min(1),
    authorization: z.string().regex(/^Bearer\s+\S+$/),
  });

export const requestIdParamSchema = z
  .object({
    requestId: z.string().uuid(),
  })
  .strict();

export const idempotencyKeyParamSchema = z
  .object({
    idempotency_key: z.string().uuid(),
  })
  .strict();

export type CreateErasureRequestInput = z.infer<typeof createErasureRequestSchema>;
export type ErasureTriggerSource = z.infer<typeof erasureTriggerSourceSchema>;
export type ErasureRequestStatus = z.infer<typeof erasureRequestStatusSchema>;
export type OutboxEventType = z.infer<typeof outboxEventTypeSchema>;
export type WorkerAckInput = z.infer<typeof workerAckSchema>;
export type WorkerOutboxEventInput = z.infer<typeof workerOutboxEventSchema>;
