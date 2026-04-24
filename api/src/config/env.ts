import { z } from "zod";
import { readSecretString } from "./secrets";

const booleanEnv = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return value;
}, z.boolean());

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://postgres:postgres@localhost:5432/postgres"),
  API_CONTROL_SCHEMA: z.string().min(1).default("dpdp_control"),
  PORT: z.coerce.number().int().positive().default(3000),
  WORKER_TASK_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  TASK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  TASK_BASE_BACKOFF_MS: z.coerce.number().int().positive().default(1000),
  WORKER_SHARED_SECRET: z.string().min(1).default("worker-secret"),
  WORKER_SHARED_SECRET_FILE: z.string().min(1).optional(),
  WORKER_REQUEST_SIGNING_SECRET: z.string().min(1).optional(),
  WORKER_REQUEST_SIGNING_SECRET_FILE: z.string().min(1).optional(),
  WORKER_REQUEST_SIGNING_MAX_SKEW_MS: z.coerce.number().int().positive().default(60000),
  WORKER_CLIENT_NAME: z.string().min(1).default("worker-1"),
  MAX_OUTBOX_PAYLOAD_BYTES: z.coerce.number().int().positive().default(32768),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  SHADOW_BURN_IN_REQUIRED: booleanEnv.default(true),
  SHADOW_REQUIRED_SUCCESSES: z.coerce.number().int().min(0).default(100),
  ADMIN_API_TOKEN: z.string().min(1).default("admin-secret"),
  ADMIN_API_TOKEN_FILE: z.string().min(1).optional(),
  PUBLIC_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  PUBLIC_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(60),
  COE_KEY_ID: z.string().min(1).default("control-plane-ed25519-v1"),
  COE_PRIVATE_KEY_PKCS8_BASE64: z.string().min(1).optional(),
  COE_PRIVATE_KEY_PKCS8_BASE64_FILE: z.string().min(1).optional(),
  COE_PUBLIC_KEY_SPKI_BASE64: z.string().min(1).optional(),
  COE_PUBLIC_KEY_SPKI_BASE64_FILE: z.string().min(1).optional(),
});

export type ApiEnv = z.infer<typeof envSchema>;

/**
 * Parses and validates API environment variables.
 *
 * @param env - Raw environment map (defaults to `process.env`).
 * @returns Strongly typed API runtime configuration.
 */
export function readApiEnv(env: Record<string, string | undefined> = process.env): ApiEnv {
  return envSchema.parse({
    ...env,
    WORKER_SHARED_SECRET: readSecretString(env.WORKER_SHARED_SECRET, env.WORKER_SHARED_SECRET_FILE),
    WORKER_REQUEST_SIGNING_SECRET: readSecretString(
      env.WORKER_REQUEST_SIGNING_SECRET,
      env.WORKER_REQUEST_SIGNING_SECRET_FILE
    ),
    ADMIN_API_TOKEN: readSecretString(env.ADMIN_API_TOKEN, env.ADMIN_API_TOKEN_FILE),
    COE_PRIVATE_KEY_PKCS8_BASE64: readSecretString(
      env.COE_PRIVATE_KEY_PKCS8_BASE64,
      env.COE_PRIVATE_KEY_PKCS8_BASE64_FILE
    ),
    COE_PUBLIC_KEY_SPKI_BASE64: readSecretString(
      env.COE_PUBLIC_KEY_SPKI_BASE64,
      env.COE_PUBLIC_KEY_SPKI_BASE64_FILE
    ),
  });
}
