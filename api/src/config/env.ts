import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://postgres:postgres@localhost:5432/postgres"),
  API_CONTROL_SCHEMA: z.string().min(1).default("dpdp_control"),
  PORT: z.coerce.number().int().positive().default(3000),
  WORKER_TASK_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  WORKER_SHARED_SECRET: z.string().min(1).default("worker-secret"),
  WORKER_CLIENT_NAME: z.string().min(1).default("worker-1"),
  MAX_OUTBOX_PAYLOAD_BYTES: z.coerce.number().int().positive().default(32768),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  COE_KEY_ID: z.string().min(1).default("control-plane-ed25519-v1"),
  COE_PRIVATE_KEY_PKCS8_BASE64: z.string().min(1).optional(),
  COE_PUBLIC_KEY_SPKI_BASE64: z.string().min(1).optional(),
});

export type ApiEnv = z.infer<typeof envSchema>;

/**
 * Parses and validates API environment variables.
 *
 * @param env - Raw environment map (defaults to `process.env`).
 * @returns Strongly typed API runtime configuration.
 */
export function readApiEnv(env: Record<string, string | undefined> = process.env): ApiEnv {
  return envSchema.parse(env);
}
