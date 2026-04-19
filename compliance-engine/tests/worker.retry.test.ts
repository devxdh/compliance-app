import { beforeEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import type { MockMailer } from "../src/engine/notifier";
import { workerError } from "../src/errors";

const vaultUserMock = vi.hoisted(() => vi.fn());
const dispatchPreErasureNoticeMock = vi.hoisted(() => vi.fn());
const shredUserMock = vi.hoisted(() => vi.fn());
const processOutboxMock = vi.hoisted(() => vi.fn());

vi.mock("../src/engine/vault", () => ({
  vaultUser: vaultUserMock,
}));

vi.mock("../src/engine/notifier", () => ({
  dispatchPreErasureNotice: dispatchPreErasureNoticeMock,
}));

vi.mock("../src/engine/shredder", () => ({
  shredUser: shredUserMock,
}));

vi.mock("../src/network/outbox", () => ({
  processOutbox: processOutboxMock,
}));

import { ComplianceWorker } from "../src/worker";
import { TEST_SECRETS } from "./helpers/db";

function buildConfig() {
  return {
    version: "1.0",
    database: {
      app_schema: "tenant_app",
      engine_schema: "tenant_engine",
    },
    compliance_policy: {
      default_retention_years: 0,
      notice_window_hours: 48,
      retention_rules: [],
    },
    graph: {
      root_table: "users",
      root_id_column: "id",
      max_depth: 32,
      root_pii_columns: {
        email: "HMAC" as const,
        full_name: "STATIC_MASK" as const,
      },
    },
    satellite_targets: [],
    outbox: {
      batch_size: 10,
      lease_seconds: 60,
      max_attempts: 10,
      base_backoff_ms: 1_000,
    },
    security: {
      notification_lease_seconds: 60,
      master_key_env: "DPDP_MASTER_KEY",
      hmac_key_env: "DPDP_HMAC_KEY",
    },
    integrity: {
      expected_schema_hash: "1".repeat(64),
    },
    masterKey: TEST_SECRETS.kek,
    hmacKey: TEST_SECRETS.hmacKey,
  };
}

function buildWorker() {
  const apiClient = {
    syncTask: vi.fn(),
    ackTask: vi.fn(),
    pushOutboxEvent: vi.fn(),
  };

  const mailer: MockMailer = {
    sendEmail: vi.fn().mockResolvedValue(undefined),
  };

  const worker = new ComplianceWorker({
    sql: {} as postgres.Sql,
    secrets: TEST_SECRETS,
    config: buildConfig(),
    apiClient,
    mailer,
  });

  return {
    worker,
    apiClient,
    mailer,
  };
}

describe("ComplianceWorker failure handling", () => {
  beforeEach(() => {
    vaultUserMock.mockReset();
    dispatchPreErasureNoticeMock.mockReset();
    shredUserMock.mockReset();
    processOutboxMock.mockReset();
  });

  it("rethrows retryable execution errors so the task can be retried without an ack", async () => {
    const { worker, apiClient } = buildWorker();
    apiClient.syncTask.mockResolvedValue({
      pending: true,
      task: {
        id: "task-retry",
        task_type: "VAULT_USER",
        payload: { userId: 42 },
      },
    });
    vaultUserMock.mockRejectedValue(
      workerError({
        code: "DPDP_DB_SERIALIZATION_FAILURE",
        title: "Serialization failure",
        detail: "Transaction rolled back due to concurrent write.",
        category: "concurrency",
        retryable: true,
      })
    );

    await expect(worker.processNextTask()).rejects.toMatchObject({
      code: "DPDP_DB_SERIALIZATION_FAILURE",
      retryable: true,
    });
    expect(apiClient.ackTask).not.toHaveBeenCalled();
  });

  it("rethrows fatal execution errors so the worker can terminate fail-closed", async () => {
    const { worker, apiClient } = buildWorker();
    apiClient.syncTask.mockResolvedValue({
      pending: true,
      task: {
        id: "task-fatal",
        task_type: "VAULT_USER",
        payload: { userId: 42 },
      },
    });
    vaultUserMock.mockRejectedValue(
      workerError({
        code: "DPDP_SCHEMA_DRIFT_DETECTED",
        title: "Schema drift detected",
        detail: "Live schema no longer matches the expected digest.",
        category: "integrity",
        retryable: false,
        fatal: true,
      })
    );

    await expect(worker.processNextTask()).rejects.toMatchObject({
      code: "DPDP_SCHEMA_DRIFT_DETECTED",
      fatal: true,
    });
    expect(apiClient.ackTask).not.toHaveBeenCalled();
  });

  it("acks non-retryable task failures with standardized problem details", async () => {
    const { worker, apiClient } = buildWorker();
    apiClient.syncTask.mockResolvedValue({
      pending: true,
      task: {
        id: "task-failed",
        task_type: "VAULT_USER",
        payload: { userId: 42 },
      },
    });
    apiClient.ackTask.mockResolvedValue(true);
    vaultUserMock.mockRejectedValue(
      workerError({
        code: "DPDP_VAULT_ROOT_ROW_NOT_FOUND",
        title: "Root row not found",
        detail: "The target row no longer exists.",
        category: "validation",
        retryable: false,
      })
    );

    await expect(worker.processNextTask()).resolves.toBe(true);
    expect(apiClient.ackTask).toHaveBeenCalledWith(
      "task-failed",
      "failed",
      expect.objectContaining({
        error: expect.objectContaining({
          code: "DPDP_VAULT_ROOT_ROW_NOT_FOUND",
          category: "validation",
          retryable: false,
          fatal: false,
          instance: "task:task-failed",
        }),
      })
    );
  });

  it("rethrows a retryable acknowledgement failure after successful task execution", async () => {
    const { worker, apiClient } = buildWorker();
    apiClient.syncTask.mockResolvedValue({
      pending: true,
      task: {
        id: "task-ack",
        task_type: "VAULT_USER",
        payload: { userId: 42 },
      },
    });
    apiClient.ackTask.mockResolvedValue(false);
    vaultUserMock.mockResolvedValue({
      action: "vaulted",
      userHash: "a".repeat(64),
      dryRun: false,
      dependencyCount: 1,
      retentionYears: 10,
      appliedRuleName: "PMLA_FINANCIAL",
      retentionExpiry: "2026-01-01T00:00:00.000Z",
      notificationDueAt: "2025-12-30T00:00:00.000Z",
      pseudonym: "dpdp_example@dpdp.invalid",
      outboxEventType: "USER_VAULTED",
    });

    await expect(worker.processNextTask()).rejects.toMatchObject({
      code: "DPDP_TASK_ACK_FAILED",
      retryable: true,
    });
  });
});
