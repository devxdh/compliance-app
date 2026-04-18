import postgres from "postgres";
import { createApp } from "./app";
import { readApiEnv } from "./config/env";
import { createEd25519Signer } from "./crypto/coe";
import { migrateApiSchema } from "./db/migrations";

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

const app = createApp({
  sql,
  controlSchema: env.API_CONTROL_SCHEMA,
  signer,
  workerSharedSecret: env.WORKER_SHARED_SECRET,
  maxOutboxPayloadBytes: env.MAX_OUTBOX_PAYLOAD_BYTES,
  taskLeaseSeconds: env.WORKER_TASK_LEASE_SECONDS,
});

export default {
  port: env.PORT,
  fetch: app.fetch,
};
