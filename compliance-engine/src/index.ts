import postgres from "postgres";
import { readFileSync } from "node:fs";
import { assertConfigSchemaCompatibility } from "./bootstrap/config-compatibility";
import { readRuntimeSecret } from "./config/secrets";
import { verifySignedWorkerConfig } from "./config/signature";
import { assertSchemaIntegrity } from "./bootstrap/integrity";
import { readWorkerConfigFromRuntime } from "./config/worker";
import { runMigrations } from "./db/migrations";
import { createRedactingSqlDebugLogger } from "./db/sql-debug";
import { workerError } from "./errors";
import type { MockMailer } from "./engine/notifier";
import { createFetchDispatcher } from "./network/outbox";
import { createControlPlaneApiClient } from "./network/control-plane";
import { createS3Client } from "./network/s3-client";
import { getLogger, logError } from "./observability/logger";
import { registerProcessGuards } from "./runtime/guards";
import { sha256Hex } from "./utils/digest";
import { ComplianceWorker } from "./worker";

const logger = getLogger({ component: "bootstrap" });
let deadLettersTotal = 0;
let workerBooted = false;

async function readOutboxQueueDepth(sql: postgres.Sql, engineSchema: string): Promise<number> {
  const [row] = await sql<{ total: number }[]>`
    SELECT COUNT(*)::int AS total
    FROM ${sql(engineSchema)}.outbox
    WHERE status IN ('pending', 'leased')
  `;

  return row?.total ?? 0;
}

function createMetricsPayload(queueDepth: number): string {
  return [
    "# HELP dpdp_outbox_queue_depth Number of relay-pending outbox rows.",
    "# TYPE dpdp_outbox_queue_depth gauge",
    `dpdp_outbox_queue_depth ${queueDepth}`,
    "# HELP dpdp_dead_letters_total Total outbox events moved to dead_letter.",
    "# TYPE dpdp_dead_letters_total counter",
    `dpdp_dead_letters_total ${deadLettersTotal}`,
    "",
  ].join("\n");
}

async function checkDatabaseHealth(sql: postgres.Sql): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sendMailerWebhook(
  url: string,
  message: Parameters<MockMailer["sendEmail"]>[0],
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(message),
      signal: controller.signal,
      redirect: "error",
    });

    if (!response.ok) {
      throw workerError({
        code: "DPDP_MAILER_TRANSPORT_FAILED",
        title: "Mailer transport failed",
        detail: `MAILER_WEBHOOK_URL responded with HTTP ${response.status}.`,
        category: "network",
        retryable: response.status >= 500 || response.status === 429,
        fatal: response.status >= 400 && response.status < 500 && response.status !== 429,
      });
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw workerError({
        code: "DPDP_MAILER_TRANSPORT_TIMEOUT",
        title: "Mailer transport timed out",
        detail: `MAILER_WEBHOOK_URL did not respond within ${timeoutMs}ms.`,
        category: "network",
        retryable: true,
        fatal: false,
      });
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  registerProcessGuards(logger);
  logger.info("Starting DPDP Compliance Worker");

  const configPath = new URL("../compliance.worker.yml", import.meta.url);
  await verifySignedWorkerConfig(process.env, configPath);
  const workerConfigHash = await sha256Hex(readFileSync(configPath, "utf8"));
  const config = await readWorkerConfigFromRuntime(process.env, configPath);
  const postgresDebug =
    (process.env.LOG_LEVEL ?? "info").toLowerCase() === "debug"
      ? createRedactingSqlDebugLogger(logger, Object.keys(config.graph.root_pii_columns))
      : undefined;

  let sql: postgres.Sql | undefined;
  let sqlReplica: postgres.Sql | undefined;

  try {
    sql = postgres(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres", {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      debug: postgresDebug,
    });

    sqlReplica = config.database.replica_db_url
      ? postgres(config.database.replica_db_url, {
        max: 10,
        idle_timeout: 20,
        connect_timeout: 10,
        debug: postgresDebug,
      })
      : undefined;

    await runMigrations(sql, config.database.engine_schema);
    await assertSchemaIntegrity(sql, config.database.app_schema, config.integrity.expected_schema_hash);
    await assertConfigSchemaCompatibility(sql, config);

    const workerClientId = process.env.API_CLIENT_ID ?? "worker-1";
    const workerBearerToken =
      readRuntimeSecret(process.env, "API_WORKER_TOKEN") || "worker-secret";
    const requestSigningSecret = readRuntimeSecret(process.env, "API_REQUEST_SIGNING_SECRET") || undefined;
    const workerAuthHeaders = {
      "x-client-id": workerClientId,
      authorization: `Bearer ${workerBearerToken}`,
    } as const;

    const pushOutboxEvent = createFetchDispatcher({
      url: process.env.API_OUTBOX_URL ?? "http://localhost:3000/api/v1/worker/outbox",
      token: workerBearerToken,
      clientId: workerClientId,
      requestSigningSecret,
      timeoutMs: 10_000,
    });

    const mailerWebhookUrl = process.env.MAILER_WEBHOOK_URL;
    if (!mailerWebhookUrl) {
      throw workerError({
        code: "DPDP_MAILER_TRANSPORT_MISSING",
        title: "Missing mailer transport",
        detail: "MAILER_WEBHOOK_URL must be configured for production notice dispatch.",
        category: "configuration",
        retryable: false,
        fatal: true,
      });
    }

    const mailerTimeoutMs = Number(process.env.MAILER_TIMEOUT_MS ?? "10000");
    const mailer: MockMailer = {
      async sendEmail(message) {
        await sendMailerWebhook(mailerWebhookUrl, message, mailerTimeoutMs);
      },
    };

    const apiClient = createControlPlaneApiClient({
      syncUrl: process.env.API_SYNC_URL ?? "http://localhost:3000/api/v1/worker/sync",
      ackBaseUrl: process.env.API_BASE_URL ?? "http://localhost:3000/api/v1/worker/tasks",
      workerAuthHeaders,
      workerConfigHash,
      workerConfigVersion: config.legal_attestation.configuration_version,
      workerDpoIdentifier: config.legal_attestation.dpo_identifier,
      pushOutboxEvent,
      requestSigningSecret,
      timeoutMs: 10_000,
    });

    const worker = new ComplianceWorker({
      sql,
      sqlReplica,
      config,
      secrets: { kek: config.masterKey, hmacKey: config.hmacKey },
      apiClient,
      mailer,
      s3Client: config.blob_targets.length > 0 ? createS3Client() : undefined,
    });

    const metricsPort = Number(process.env.METRICS_PORT ?? "9464");
    Bun.serve({
      port: metricsPort,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/healthz") {
          return new Response("ok", { status: 200 });
        }

        if (url.pathname === "/readyz") {
          const ready = workerBooted && (await checkDatabaseHealth(sql!));
          return new Response(ready ? "ready" : "not ready", {
            status: ready ? 200 : 503,
          });
        }

        if (url.pathname === "/metrics") {
          const queueDepth = await readOutboxQueueDepth(sql!, config.database.engine_schema);
          return new Response(createMetricsPayload(queueDepth), {
            status: 200,
            headers: {
              "content-type": "text/plain; version=0.0.4; charset=utf-8",
            },
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    workerBooted = true;
    logger.info(
      {
        appSchema: config.database.app_schema,
        engineSchema: config.database.engine_schema,
        replicaEnabled: Boolean(sqlReplica),
        metricsPort,
        mailerTimeoutMs,
        workerConfigHash,
        workerConfigVersion: config.legal_attestation.configuration_version,
        dpoIdentifier: config.legal_attestation.dpo_identifier,
      },
      "DPDP Compliance Worker booted"
    );

    while (true) {
      try {
        const processed = await worker.processNextTask();
        const relay = await worker.flushOutbox();
        deadLettersTotal += relay.deadLettered;

        if (!processed) {
          await sleep(5_000);
        }
      } catch (error) {
        const normalized = logError(logger, error, "Worker loop iteration failed");
        if (normalized.fatal) {
          throw normalized;
        }

        await sleep(normalized.retryable ? 5_000 : 10_000);
      }
    }
  } finally {
    const shutdownTasks: Promise<unknown>[] = [];
    if (sql) {
      shutdownTasks.push(sql.end());
    }
    if (sqlReplica) {
      shutdownTasks.push(sqlReplica.end());
    }
    await Promise.allSettled(shutdownTasks);
  }
}

main().catch((error) => {
  logError(logger, error, "Worker failed to start");
  process.exit(1);
});
