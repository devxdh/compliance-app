import { describe, expect, it } from "vitest";
import { readWorkerConfig } from "../src/config/worker";

describe("Worker configuration", () => {
  const masterKeyHex = "42".repeat(32);
  const hmacKeyBase64 = Buffer.from(new Uint8Array(32).fill(0x24)).toString("base64");

  it("parses validated worker configuration from hex and base64 keys", () => {
    const config = readWorkerConfig({
      DPDP_MASTER_KEY: masterKeyHex,
      DPDP_HMAC_KEY: `base64:${hmacKeyBase64}`,
      DPDP_APP_SCHEMA: "tenant_app",
      DPDP_ENGINE_SCHEMA: "tenant_engine",
      DPDP_RETENTION_YEARS: "7",
      DPDP_NOTICE_WINDOW_HOURS: "72",
      DPDP_GRAPH_MAX_DEPTH: "64",
      DPDP_OUTBOX_BATCH_SIZE: "20",
      DPDP_OUTBOX_LEASE_SECONDS: "90",
      DPDP_OUTBOX_MAX_ATTEMPTS: "12",
      DPDP_OUTBOX_BASE_BACKOFF_MS: "1500",
      DPDP_NOTIFICATION_LEASE_SECONDS: "180",
      DPDP_REPLICA_DATABASE_URL: "postgres://replica:replica@replica-host:5432/postgres",
    });

    expect(config.appSchema).toBe("tenant_app");
    expect(config.engineSchema).toBe("tenant_engine");
    expect(config.retentionYears).toBe(7);
    expect(config.noticeWindowHours).toBe(72);
    expect(config.graphMaxDepth).toBe(64);
    expect(config.outboxBatchSize).toBe(20);
    expect(config.outboxLeaseSeconds).toBe(90);
    expect(config.outboxMaxAttempts).toBe(12);
    expect(config.outboxBaseBackoffMs).toBe(1500);
    expect(config.notificationLeaseSeconds).toBe(180);
    expect(config.replicaDbUrl).toBe("postgres://replica:replica@replica-host:5432/postgres");
    expect(Buffer.from(config.masterKey).toString("hex")).toBe(masterKeyHex);
    expect(Buffer.from(config.hmacKey).toString("base64")).toBe(hmacKeyBase64);
  });

  it("falls back to the master key for HMAC when no dedicated HMAC key is configured", () => {
    const config = readWorkerConfig({
      DPDP_MASTER_KEY: masterKeyHex,
    });

    expect(Buffer.from(config.hmacKey).toString("hex")).toBe(masterKeyHex);
    expect(config.replicaDbUrl).toBeUndefined();
  });

  it("rejects malformed keys and schema names", () => {
    expect(() =>
      readWorkerConfig({
        DPDP_MASTER_KEY: "abcd",
      })
    ).toThrow(/exactly 32 bytes/i);

    expect(() =>
      readWorkerConfig({
        DPDP_MASTER_KEY: masterKeyHex,
        DPDP_APP_SCHEMA: "tenant-app",
      })
    ).toThrow(/invalid application schema name/i);
  });
});
