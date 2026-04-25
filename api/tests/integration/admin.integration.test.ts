import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createApp } from "../../src/app";
import { createEd25519Signer } from "../../src/crypto/coe";
import { migrateApiSchema } from "../../src/db/migrations";
import { computeWormHash } from "../../src/modules/control-plane/hash";
import { createTestSql, dropSchemas, uniqueSchema } from "../helpers/db";

describe("Control Plane Admin (Integration)", () => {
  let sql: postgres.Sql;
  const schemasToDrop: string[] = [];

  beforeAll(() => {
    sql = createTestSql();
  });

  afterAll(async () => {
    await dropSchemas(sql, ...schemasToDrop);
    await sql.end();
  });

  async function setup(now: Date = new Date("2026-04-20T10:00:00.000Z")) {
    const controlSchema = uniqueSchema("admin_api");
    schemasToDrop.push(controlSchema);
    await dropSchemas(sql, controlSchema);
    await migrateApiSchema(sql, controlSchema);

    const app = createApp({
      sql,
      controlSchema,
      signer: await createEd25519Signer("integration-key"),
      workerSharedSecret: "worker-secret",
      adminApiToken: "admin-secret",
      workerClientName: "worker-1",
      maxOutboxPayloadBytes: 2048,
      shadowBurnInRequired: false,
      now: () => now,
    });

    const bootstrapClient = await sql<any[]>`
      INSERT INTO ${sql(controlSchema)}.clients (name, worker_api_key_hash)
      VALUES ('worker-1', '6fb46f7a92742970166379ed5195e79c4493a7cc5664280c039cfd4095ba5faf')
      RETURNING id
    `;
    const workerId = bootstrapClient[0]!.id;

    return { app, controlSchema, workerId };
  }

  function adminHeaders() {
    return {
      authorization: "Bearer admin-secret",
      "content-type": "application/json",
    };
  }

  function workerHeaders(workerId: string) {
    return {
      "x-client-id": workerId,
      authorization: "Bearer worker-secret",
      "x-worker-config-hash": "ab".repeat(32),
      "x-worker-config-version": "v-test",
      "x-worker-dpo-identifier": "dpo@example.com",
      "content-type": "application/json",
    };
  }

  function buildErasureRequest(overrides: Record<string, unknown> = {}) {
    return {
      subject_opaque_id: "usr_admin_flow",
      idempotency_key: crypto.randomUUID(),
      trigger_source: "USER_CONSENT_WITHDRAWAL",
      actor_opaque_id: "usr_admin_flow",
      legal_framework: "DPDP_2023",
      request_timestamp: "2026-04-20T10:00:00.000Z",
      cooldown_days: 0,
      shadow_mode: false,
      ...overrides,
    };
  }

  it("creates, lists, rotates, and deactivates worker clients", async () => {
    const { app, workerId } = await setup();

    const createResponse = await app.request("/api/v1/admin/clients", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        name: "tenant-blue",
        display_name: "Tenant Blue",
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      client: { name: string; current_key_id: string; is_active: boolean };
      bearer_token: string;
    };
    expect(created.client.name).toBe("tenant-blue");
    expect(created.client.is_active).toBe(true);
    expect(created.bearer_token).toMatch(/^wkr_/);

    const listResponse = await app.request("/api/v1/admin/clients", {
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    expect(listResponse.status).toBe(200);
    const clients = (await listResponse.json()) as Array<{ name: string }>;
    expect(clients.map((client) => client.name)).toContain("tenant-blue");

    const rotateResponse = await app.request("/api/v1/admin/clients/tenant-blue/rotate-key", {
      method: "POST",
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    expect(rotateResponse.status).toBe(200);
    const rotated = (await rotateResponse.json()) as {
      client: { current_key_id: string };
      bearer_token: string;
    };
    expect(rotated.client.current_key_id).not.toBe(created.client.current_key_id);
    expect(rotated.bearer_token).toMatch(/^wkr_/);

    const deactivateResponse = await app.request("/api/v1/admin/clients/tenant-blue/deactivate", {
      method: "POST",
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    expect(deactivateResponse.status).toBe(200);
    expect(await deactivateResponse.json()).toEqual(
      expect.objectContaining({
        name: "tenant-blue",
        is_active: false,
      })
    );
  });

  it("lists and requeues dead-letter tasks", async () => {
    const { app, workerId } = await setup();
    const request = buildErasureRequest();
    const createResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify(request),
    });
    const created = (await createResponse.json()) as { task_id: string };

    await app.request("/api/v1/worker/sync", {
      headers: workerHeaders(workerId),
    });
    await app.request(`/api/v1/worker/tasks/${created.task_id}/ack`, {
      method: "POST",
      headers: workerHeaders(workerId),
      body: JSON.stringify({
        status: "failed",
        result: {
          error: {
            code: "DPDP_TASK_PAYLOAD_INVALID",
            title: "Invalid task payload",
            detail: "Malformed input",
            category: "validation",
            retryable: false,
            fatal: false,
          },
        },
      }),
    });

    const deadLettersResponse = await app.request("/api/v1/admin/tasks/dead-letters", {
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    expect(deadLettersResponse.status).toBe(200);
    expect(await deadLettersResponse.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.task_id,
          status: "DEAD_LETTER",
        }),
      ])
    );

    const requeueResponse = await app.request(`/api/v1/admin/tasks/${created.task_id}/requeue`, {
      method: "POST",
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    expect(requeueResponse.status).toBe(200);
    expect(await requeueResponse.json()).toEqual(
      expect.objectContaining({
        id: created.task_id,
        status: "QUEUED",
      })
    );
  });

  it("summarizes usage and exports audit ledger entries", async () => {
    const { app, workerId } = await setup();
    const request = buildErasureRequest({
      subject_opaque_id: "usr_usage_export",
      actor_opaque_id: "usr_usage_export",
    });
    const createResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify(request),
    });
    const created = (await createResponse.json()) as { request_id: string; task_id: string };

    const leaseResponse = await app.request("/api/v1/worker/sync", {
      headers: workerHeaders(workerId),
    });
    expect(leaseResponse.status).toBe(200);

    const ackResponse = await app.request(`/api/v1/worker/tasks/${created.task_id}/ack`, {
      method: "POST",
      headers: workerHeaders(workerId),
      body: JSON.stringify({
        status: "completed",
        result: {
          action: "vaulted",
        },
      }),
    });
    expect(ackResponse.status).toBe(200);

    const payload = {
      request_id: created.request_id,
      subject_opaque_id: "usr_usage_export",
      trigger_source: "USER_CONSENT_WITHDRAWAL",
      actor_opaque_id: "usr_usage_export",
      legal_framework: "DPDP_2023",
      applied_rule_name: "DEFAULT",
      applied_rule_citation: "Configured default_retention_years policy",
      event_timestamp: "2026-04-20T10:00:00.000Z",
      notification_due_at: "2026-04-20T12:00:00.000Z",
      retention_expiry: "2026-04-21T10:00:00.000Z",
    };
    const currentHash = await computeWormHash("GENESIS", payload, "vault_usage_export");

    const outboxResponse = await app.request("/api/v1/worker/outbox", {
      method: "POST",
      headers: workerHeaders(workerId),
      body: JSON.stringify({
        idempotency_key: "vault_usage_export",
        request_id: created.request_id,
        subject_opaque_id: "usr_usage_export",
        event_type: "USER_VAULTED",
        payload,
        previous_hash: "GENESIS",
        current_hash: currentHash,
        event_timestamp: "2026-04-20T10:00:00.000Z",
      }),
    });
    expect(outboxResponse.status).toBe(202);

    const usageResponse = await app.request("/api/v1/admin/usage", {
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    expect(usageResponse.status).toBe(200);
    expect(await usageResponse.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client_name: "worker-1",
          event_type: "USER_VAULTED",
          total_units: 1,
          event_count: 1,
        }),
      ])
    );

    const exportResponse = await app.request("/api/v1/admin/audit/export", {
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    expect(exportResponse.status).toBe(200);
    const lines = (await exportResponse.text()).trim().split("\n");
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          worker_idempotency_key: "vault_usage_export",
          event_type: "USER_VAULTED",
        }),
        expect.objectContaining({
          event_type: "WORKER_CONFIG_HEARTBEAT",
        }),
      ])
    );
  });

  it("exposes prometheus metrics for request accounting", async () => {
    const { app, workerId } = await setup();

    await app.request("/health");
    const metricsResponse = await app.request("/metrics");
    expect(metricsResponse.status).toBe(200);
    const metrics = await metricsResponse.text();
    expect(metrics).toContain("dpdp_api_http_requests_total");
    expect(metrics).toContain("dpdp_api_http_request_duration_seconds");
  });
});
