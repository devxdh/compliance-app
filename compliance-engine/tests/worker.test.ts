import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import {
  createTestSql,
  dropSchemas,
  insertUser,
  prepareWorkerSchemas,
  uniqueSchema,
  TEST_SECRETS,
} from "./helpers/db";
import type { MockMailer } from "../src/engine/notifier";
import { ComplianceWorker } from "../src/worker";

describe("Compliance Worker Daemon (E2E Lifecycle)", () => {
  let sql: postgres.Sql;
  const schemasToDrop: string[] = [];

  beforeAll(() => {
    sql = createTestSql();
  });

  afterAll(async () => {
    await dropSchemas(sql, ...schemasToDrop);
    await sql.end();
  });

  it("orchestrates the full lifecycle: vault -> outbox sync -> notify -> shred", async () => {
    const appSchema = uniqueSchema("e2e_app");
    const engineSchema = uniqueSchema("e2e_engine");
    schemasToDrop.push(appSchema, engineSchema);

    // Setup fresh schemas
    await prepareWorkerSchemas(sql, appSchema, engineSchema, {
      withDependencies: true,
    });

    const userId = await insertUser(sql, appSchema, "e2e@example.com", "E2E User");

    // 1. Mock the Central API (The Brain)
    const mockApi = {
      syncTask: vi.fn(),
      ackTask: vi.fn(),
      pushOutboxEvent: vi.fn(),
    };

    // 2. Mock the Mailer (SMTP Transport)
    const mockMailer: MockMailer = {
      sendEmail: vi.fn().mockResolvedValue(undefined),
    };

    // 3. Initialize the Worker Runtime (The class we will build next!)
    const worker = new ComplianceWorker({
      sql,
      secrets: TEST_SECRETS,
      config: {
        appSchema,
        engineSchema,
        retentionYears: 5,
        noticeWindowHours: 48,
        graphMaxDepth: 32,
        outboxBatchSize: 10,
        outboxLeaseSeconds: 60,
        outboxMaxAttempts: 3,
        outboxBaseBackoffMs: 100,
        notificationLeaseSeconds: 60,
        masterKey: TEST_SECRETS.kek,
        hmacKey: TEST_SECRETS.hmacKey,
      },
      apiClient: mockApi,
      mailer: mockMailer,
    });

    // --- STAGE 1: VAULTING ---
    // Simulate the API giving us a VAULT_USER task
    mockApi.syncTask.mockResolvedValueOnce({
      pending: true,
      task: { id: "task-1", task_type: "VAULT_USER", payload: { userId } },
    });
    mockApi.ackTask.mockResolvedValueOnce(true);
    mockApi.pushOutboxEvent.mockResolvedValueOnce(true);

    // Run one loop of the worker to process the task
    await worker.processNextTask();

    expect(mockApi.syncTask).toHaveBeenCalled();
    expect(mockApi.ackTask).toHaveBeenCalledWith("task-1", "completed", expect.objectContaining({ action: "vaulted" }));

    // Flush the outbox to ensure the API receives the USER_VAULTED event
    await worker.flushOutbox();
    expect(mockApi.pushOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "USER_VAULTED" })
    );

    // --- STAGE 3: NOTIFYING ---
    // Fast forward time to trigger the notification window (e.g., 4.9 years later)
    const notifyTime = new Date();
    notifyTime.setUTCFullYear(notifyTime.getUTCFullYear() + 5);
    notifyTime.setUTCDate(notifyTime.getUTCDate() - 1);

    mockApi.syncTask.mockResolvedValueOnce({
      pending: true,
      task: { id: "task-2", task_type: "NOTIFY_USER", payload: { userId, now: notifyTime.toISOString() } },
    });
    mockApi.ackTask.mockResolvedValueOnce(true);

    await worker.processNextTask();

    expect(mockMailer.sendEmail).toHaveBeenCalledTimes(1);
    expect(mockApi.ackTask).toHaveBeenCalledWith("task-2", "completed", expect.objectContaining({ action: "sent" }));

    // --- STAGE 4: SHREDDING ---
    // Fast forward past the expiry date
    const shredTime = new Date(notifyTime);
    shredTime.setUTCDate(shredTime.getUTCDate() + 3);

    mockApi.syncTask.mockResolvedValueOnce({
      pending: true,
      task: { id: "task-3", task_type: "SHRED_USER", payload: { userId, now: shredTime.toISOString() } },
    });
    mockApi.ackTask.mockResolvedValueOnce(true);

    await worker.processNextTask();

    expect(mockApi.ackTask).toHaveBeenCalledWith("task-3", "completed", expect.objectContaining({ action: "shredded" }));

    // Verify Final Database State: Key is gone, payload is { destroyed: true }
    const [vaultRow] = await sql`SELECT encrypted_pii FROM ${sql(engineSchema)}.pii_vault WHERE root_id = ${userId.toString()}`;
    expect(vaultRow?.encrypted_pii).toEqual({ v: 1, destroyed: true });
  });
});
