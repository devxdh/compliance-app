import postgres from "postgres";
import { assertSchemaIntegrity } from "./bootstrap/integrity";
import { readWorkerConfig } from "./config/worker";
import type { MockMailer } from "./engine/notifier";
import { createFetchDispatcher } from "./network/outbox";
import { createControlPlaneApiClient } from "./network/control-plane";
import { getLogger, logError } from "./observability/logger";
import { registerProcessGuards } from "./runtime/guards";
import { ComplianceWorker } from "./worker";

const logger = getLogger({ component: "bootstrap" });

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  registerProcessGuards(logger);
  logger.info("Starting DPDP Compliance Worker");

  const config = readWorkerConfig();

  let sql: postgres.Sql | undefined;
  let sqlReplica: postgres.Sql | undefined;

  try {
    sql = postgres(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres", {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    });

    sqlReplica = config.database.replica_db_url
      ? postgres(config.database.replica_db_url, {
          max: 10,
          idle_timeout: 20,
          connect_timeout: 10,
        })
      : undefined;

    await assertSchemaIntegrity(sql, config.database.app_schema, config.integrity.expected_schema_hash);

    const workerClientId = process.env.API_CLIENT_ID ?? "worker-1";
    const workerBearerToken = process.env.API_WORKER_TOKEN ?? "worker-secret";
    const workerAuthHeaders = {
      "x-client-id": workerClientId,
      authorization: `Bearer ${workerBearerToken}`,
    } as const;

    const pushOutboxEvent = createFetchDispatcher({
      url: process.env.API_OUTBOX_URL ?? "http://localhost:3000/api/v1/worker/outbox",
      token: workerBearerToken,
      clientId: workerClientId,
      timeoutMs: 10_000,
    });

    const mailer: MockMailer = {
      async sendEmail(message) {
        logger.info({ idempotencyKey: message.idempotencyKey }, "SMTP mock accepted notification");
      },
    };

    const apiClient = createControlPlaneApiClient({
      syncUrl: process.env.API_SYNC_URL ?? "http://localhost:3000/api/v1/worker/sync",
      ackBaseUrl: process.env.API_BASE_URL ?? "http://localhost:3000/api/v1/worker/tasks",
      workerAuthHeaders,
      pushOutboxEvent,
      timeoutMs: 10_000,
    });

    const worker = new ComplianceWorker({
      sql,
      sqlReplica,
      config,
      secrets: { kek: config.masterKey, hmacKey: config.hmacKey },
      apiClient,
      mailer,
    });

    logger.info(
      {
        appSchema: config.database.app_schema,
        engineSchema: config.database.engine_schema,
        replicaEnabled: Boolean(sqlReplica),
      },
      "DPDP Compliance Worker booted"
    );

    while (true) {
      try {
        const processed = await worker.processNextTask();
        await worker.flushOutbox();

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
