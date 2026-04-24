import postgres from "postgres";
import { createApp } from "./app";
import { readApiEnv } from "./config/env";
import { createEd25519Signer } from "./crypto/coe";
import { migrateApiSchema } from "./db/migrations";
import { computeTokenHash } from "./modules/control-plane/hash";
import { ControlPlaneRepository } from "./modules/control-plane/repository";

const env = readApiEnv();
const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

const signer = await createEd25519Signer(env.COE_KEY_ID, {
  privateKeyPkcs8Base64: env.COE_PRIVATE_KEY_PKCS8_BASE64,
  publicKeySpkiBase64: env.COE_PUBLIC_KEY_SPKI_BASE64,
});

await migrateApiSchema(sql, env.API_CONTROL_SCHEMA);

const bootstrapRepository = new ControlPlaneRepository(
  sql,
  env.API_CONTROL_SCHEMA,
  env.WORKER_TASK_LEASE_SECONDS,
  env.TASK_MAX_ATTEMPTS,
  env.TASK_BASE_BACKOFF_MS
);

await bootstrapRepository.ensureClient(
  env.WORKER_CLIENT_NAME,
  await computeTokenHash(env.WORKER_SHARED_SECRET)
);

const app = createApp({
  sql,
  controlSchema: env.API_CONTROL_SCHEMA,
  signer,
  workerSharedSecret: env.WORKER_SHARED_SECRET,
  workerRequestSigningSecret: env.WORKER_REQUEST_SIGNING_SECRET,
  workerRequestSigningMaxSkewMs: env.WORKER_REQUEST_SIGNING_MAX_SKEW_MS,
  workerClientName: env.WORKER_CLIENT_NAME,
  maxOutboxPayloadBytes: env.MAX_OUTBOX_PAYLOAD_BYTES,
  taskLeaseSeconds: env.WORKER_TASK_LEASE_SECONDS,
  taskMaxAttempts: env.TASK_MAX_ATTEMPTS,
  taskBaseBackoffMs: env.TASK_BASE_BACKOFF_MS,
  webhookTimeoutMs: env.WEBHOOK_TIMEOUT_MS,
  shadowBurnInRequired: env.SHADOW_BURN_IN_REQUIRED,
  shadowRequiredSuccesses: env.SHADOW_REQUIRED_SUCCESSES,
  adminApiToken: env.ADMIN_API_TOKEN,
  publicRateLimitWindowMs: env.PUBLIC_RATE_LIMIT_WINDOW_MS,
  publicRateLimitMaxRequests: env.PUBLIC_RATE_LIMIT_MAX_REQUESTS,
});

export default {
  port: env.PORT,
  fetch: app.fetch,
};
