import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://postgres:postgres@localhost:5432/postgres"),
  API_CONTROL_SCHEMA: z.string().min(1).default("dpdp_control"),
  PORT: z.coerce.number().int().positive().default(3000),
  WORKER_TASK_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  COE_KEY_ID: z.string().min(1).default("control-plane-ed25519-v1"),
  COE_PRIVATE_KEY_PKCS8_BASE64: z.string().min(1).optional(),
  COE_PUBLIC_KEY_SPKI_BASE64: z.string().min(1).optional(),
});

export type ApiEnv = z.infer<typeof envSchema>;

/**
 * Parses and validates API environment variables.
 */
export function readApiEnv(env: Record<string, string | undefined> = process.env): ApiEnv {
  return envSchema.parse(env);
}

