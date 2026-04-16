import { z } from "zod";

/**
 * Validation schemas for worker-facing API payloads.
 */
export const clientIdHeaderSchema = z.string().min(1);

export const taskPayloadSchema = z.record(z.string(), z.unknown());

export const enqueueTaskSchema = z.object({
  task_type: z.string().min(1),
  payload: taskPayloadSchema,
});

export const outboxIngestSchema = z.object({
  event_type: z.string().min(1),
  payload: taskPayloadSchema,
  idempotency_key: z.string().min(1).optional(),
});

export const ackTaskSchema = z.object({
  status: z.enum(["completed", "failed", "cancelled"]),
  result: taskPayloadSchema.optional(),
  error: z.string().min(1).optional(),
});

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
