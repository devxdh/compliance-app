import postgres from "postgres";
import { readWorkerConfig } from "./config/worker";
import { ComplianceWorker, type ApiClient } from "./worker";
import { createFetchDispatcher } from "./network/outbox";
import type { MockMailer } from "./engine/notifier";

/**
 * Layman Terms:
 * This is the main "Start Button" for the application. It turns the engine on, connects to the database,
 * and starts asking the Central API for jobs. It will run forever until you turn it off.
 *
 * Technical Terms:
 * The entry point for the Compliance Worker daemon. It initializes the PostgreSQL connection pool,
 * loads the validated environment configuration via `readWorkerConfig`, instantiates the `ComplianceWorker`,
 * and begins a continuous asynchronous polling loop with exponential backoff for error handling.
 */
async function main() {
  console.log("[BOOT] Starting DPDP Compliance Worker...");

  // 1. Read and validate environment configuration (Fails fast if keys are missing)
  const config = readWorkerConfig();

  // 2. Initialize the Postgres Connection Pool
  const sql = postgres(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres", {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  // 3. Initialize real HTTP dispatcher for the outbox
  const pushOutboxEvent = createFetchDispatcher({
    url: process.env.API_OUTBOX_URL ?? "http://localhost:3000/api/v1/worker/outbox",
    timeoutMs: 10000
  });

  // 4. Initialize the Mailer
  const mailer: MockMailer = {
    async sendEmail(to, subject, body) {
      console.log(`[SMTP_MOCK] Sending email to ${to}: ${subject}`);
      // Integration Note: In a real deployment, hook this up to Nodemailer, SendGrid, or AWS SES
    }
  };

  // 5. Build the API Client to talk to the Control Plane
  const apiClient = {
    async syncTask() {
      try {
        const res = await fetch(process.env.API_SYNC_URL ?? "http://localhost:3000/api/v1/worker/sync", {
          headers: { "x-client-id": "worker-1" }
        });
        if (res.status === 200) return await res.json();
      } catch (e) { /* ignore network drops during polling */ }
      return { pending: false };
    },
    async ackTask(taskId: string, status: string, result: any) {
      try {
        const res = await fetch(`${process.env.API_BASE_URL ?? "http://localhost:3000/api/v1/worker/tasks"}/${taskId}/ack`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-client-id": "worker-1" },
          body: JSON.stringify({ status, result })
        });
        return res.ok;
      } catch (e) {
        return false;
      }
    },
    pushOutboxEvent
  };

  // 6. Instantiate the core worker
  const worker = new ComplianceWorker({
    sql,
    config,
    secrets: { kek: config.masterKey, hmacKey: config.hmacKey },
    apiClient: apiClient as ApiClient,
    mailer
  });

  console.log("[BOOT] DPDP Compliance Worker is running. Polling for tasks...");

  // 7. The Infinite Event Loop
  while (true) {
    try {
      // Attempt to process an incoming command from the Central API
      const processed = await worker.processNextTask();

      // Flush any pending network webhooks
      await worker.flushOutbox();

      // If there was no task to process, sleep to prevent CPU spin-locking
      if (!processed) {
        await new Promise((res) => setTimeout(res, 5000));
      }
    } catch (error) {
      console.error("[CRITICAL_ERROR] Worker loop crashed. Restarting in 10s...", error);
      await new Promise((res) => setTimeout(res, 10000));
    }
  }
}

// Global exception handler
main().catch(err => {
  console.error("[FATAL] Worker failed to start:", err);
  process.exit(1);
});
