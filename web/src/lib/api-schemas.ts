import { z } from "zod";

const dateStringSchema = z.string();
const nullableDateStringSchema = z.string().nullable();
const jsonRecordSchema = z.record(z.string(), z.unknown());

export const erasureRequestStatusSchema = z.enum([
  "WAITING_COOLDOWN",
  "EXECUTING",
  "VAULTED",
  "NOTICE_SENT",
  "SHREDDED",
  "FAILED",
  "CANCELLED",
]);

export const erasureTriggerSourceSchema = z.enum([
  "USER_CONSENT_WITHDRAWAL",
  "PURPOSE_FULFILLED",
  "ADMIN_PURGE",
]);

export const clientSchema = z.object({
  id: z.string(),
  name: z.string(),
  display_name: z.string().nullable(),
  current_key_id: z.string(),
  is_active: z.boolean(),
  shadow_success_count: z.number(),
  shadow_required_successes: z.number(),
  live_mutation_enabled: z.boolean(),
  live_mutation_enabled_at: nullableDateStringSchema,
  rotated_at: dateStringSchema,
  last_authenticated_at: nullableDateStringSchema,
  created_at: dateStringSchema,
});

export const usageSummarySchema = z.object({
  client_name: z.string(),
  event_type: z.string(),
  total_units: z.number(),
  event_count: z.number(),
});

export const auditLedgerRowSchema = z.object({
  id: z.string(),
  ledger_seq: z.number(),
  client_id: z.string(),
  worker_idempotency_key: z.string(),
  event_type: z.string(),
  payload: z.unknown(),
  previous_hash: z.string(),
  current_hash: z.string(),
  created_at: dateStringSchema,
});

export const deadLetterTaskSchema = z.object({
  id: z.string(),
  client_id: z.string(),
  erasure_job_id: z.string(),
  task_type: z.enum(["VAULT_USER", "NOTIFY_USER", "SHRED_USER"]),
  payload: jsonRecordSchema,
  status: z.literal("DEAD_LETTER"),
  worker_client_name: z.string().nullable(),
  leased_at: nullableDateStringSchema,
  lease_expires_at: nullableDateStringSchema,
  completed_at: nullableDateStringSchema,
  shadow_burn_in_recorded_at: nullableDateStringSchema,
  attempt_count: z.number(),
  next_attempt_at: dateStringSchema,
  dead_lettered_at: nullableDateStringSchema,
  error_text: z.string().nullable(),
  created_at: dateStringSchema,
  updated_at: dateStringSchema,
});

export const requeueTaskResponseSchema = deadLetterTaskSchema.extend({
  status: z.enum(["QUEUED", "DISPATCHED", "COMPLETED", "FAILED", "DEAD_LETTER"]),
});

export const erasureJobSchema = z.object({
  id: z.string(),
  client_id: z.string(),
  idempotency_key: z.string(),
  subject_opaque_id: z.string(),
  trigger_source: erasureTriggerSourceSchema,
  actor_opaque_id: z.string(),
  legal_framework: z.string(),
  applied_rule_name: z.string().nullable(),
  applied_rule_citation: z.string().nullable(),
  request_timestamp: dateStringSchema,
  tenant_id: z.string().nullable(),
  cooldown_days: z.number(),
  shadow_mode: z.boolean(),
  webhook_url: z.string().nullable(),
  status: erasureRequestStatusSchema,
  vault_due_at: dateStringSchema,
  notification_due_at: nullableDateStringSchema,
  shred_due_at: nullableDateStringSchema,
  shredded_at: nullableDateStringSchema,
  created_at: dateStringSchema,
  updated_at: dateStringSchema,
});

export const clientTokenResponseSchema = z.object({
  client: clientSchema,
  bearer_token: z.string(),
});

export type ErasureRequestStatus = z.infer<typeof erasureRequestStatusSchema>;
export type WorkerClient = z.infer<typeof clientSchema>;
export type UsageSummary = z.infer<typeof usageSummarySchema>;
export type AuditLedgerRow = z.infer<typeof auditLedgerRowSchema>;
export type DeadLetterTask = z.infer<typeof deadLetterTaskSchema>;
export type RequeueTaskResponse = z.infer<typeof requeueTaskResponseSchema>;
export type ErasureJob = z.infer<typeof erasureJobSchema>;
export type ClientTokenResponse = z.infer<typeof clientTokenResponseSchema>;
