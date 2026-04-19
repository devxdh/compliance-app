import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { createApp } from "../../src/app";
import { createEd25519Signer } from "../../src/crypto/coe";
import { migrateApiSchema } from "../../src/db/migrations";
import { computeWormHash } from "../../src/modules/control-plane/hash";
import { createTestSql, dropSchemas, uniqueSchema } from "../helpers/db";

describe("Control Plane API (Integration)", () => {
  let sql: postgres.Sql;
  const schemasToDrop: string[] = [];

  beforeAll(() => {
    sql = createTestSql();
  });

  afterAll(async () => {
    await dropSchemas(sql, ...schemasToDrop);
    await sql.end();
  });

  async function setup() {
    const controlSchema = uniqueSchema("control_api");
    schemasToDrop.push(controlSchema);
    await dropSchemas(sql, controlSchema);
    await migrateApiSchema(sql, controlSchema);

    const app = createApp({
      sql,
      controlSchema,
      signer: await createEd25519Signer("integration-key"),
      workerSharedSecret: "worker-secret",
      workerClientName: "worker-1",
      maxOutboxPayloadBytes: 2048,
    });

    return { app, controlSchema };
  }

  function buildWorkerAuthHeaders(token: string = "worker-secret") {
    return {
      "x-client-id": "worker-1",
      authorization: `Bearer ${token}`,
    };
  }

  function buildErasureRequest(overrides: Record<string, unknown> = {}) {
    return {
      subject_opaque_id: "usr_8847a92b_4f1c_882a",
      idempotency_key: crypto.randomUUID(),
      trigger_source: "USER_CONSENT_WITHDRAWAL",
      actor_opaque_id: "usr_8847a92b_4f1c_882a",
      legal_framework: "DPDP_2023",
      request_timestamp: "2026-04-19T10:00:00.000Z",
      cooldown_days: 30,
      shadow_mode: false,
      ...overrides,
    };
  }

  async function computeCurrentHash(previousHash: string, payload: unknown, idempotencyKey: string): Promise<string> {
    return computeWormHash(previousHash, payload, idempotencyKey);
  }

  it("rejects undeclared PII fields and missing mandatory actor metadata", async () => {
    const { app } = await setup();

    const extraFieldResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...buildErasureRequest(),
        email: "alice@example.com",
      }),
    });
    expect(extraFieldResponse.status).toBe(400);

    const missingActorResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject_opaque_id: "usr_missing_actor",
        idempotency_key: crypto.randomUUID(),
        trigger_source: "USER_CONSENT_WITHDRAWAL",
        legal_framework: "DPDP_2023",
        request_timestamp: "2026-04-19T10:00:00.000Z",
      }),
    });
    expect(missingActorResponse.status).toBe(400);
  });

  it("sync dispatches only due jobs and ignores cancelled or future cooldown work", async () => {
    const { app, controlSchema } = await setup();
    const futureJob = buildErasureRequest({ subject_opaque_id: "usr_future", cooldown_days: 30 });
    const cancelledJob = buildErasureRequest({ subject_opaque_id: "usr_cancel", cooldown_days: 30 });
    const dueJob = buildErasureRequest({ subject_opaque_id: "usr_due", cooldown_days: 0, tenant_id: "tenant_a" });

    await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(futureJob),
    });

    const cancelledCreate = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cancelledJob),
    });
    expect(cancelledCreate.status).toBe(202);

    const cancelResponse = await app.request(`/api/v1/erasure-requests/${cancelledJob.idempotency_key}/cancel`, {
      method: "POST",
    });
    expect(cancelResponse.status).toBe(200);

    const dueCreate = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dueJob),
    });
    const dueCreated = (await dueCreate.json()) as { request_id: string; task_id: string };

    const syncResponse = await app.request("/api/v1/worker/sync", {
      method: "GET",
      headers: buildWorkerAuthHeaders(),
    });
    expect(syncResponse.status).toBe(200);
    const syncPayload = (await syncResponse.json()) as {
      pending: boolean;
      task?: {
        id: string;
        task_type: "VAULT_USER";
        payload: {
          request_id: string;
          subject_opaque_id: string;
          tenant_id?: string;
        };
      };
    };

    expect(syncPayload.pending).toBe(true);
    expect(syncPayload.task?.id).toBe(dueCreated.task_id);
    expect(syncPayload.task?.payload.request_id).toBe(dueCreated.request_id);
    expect(syncPayload.task?.payload.subject_opaque_id).toBe("usr_due");
    expect(syncPayload.task?.payload.tenant_id).toBe("tenant_a");

    await app.request(`/api/v1/worker/tasks/${dueCreated.task_id}/ack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders(),
      },
      body: JSON.stringify({
        status: "completed",
        result: { action: "vaulted" },
      }),
    });

    const secondSync = await app.request("/api/v1/worker/sync", {
      method: "GET",
      headers: buildWorkerAuthHeaders(),
    });
    expect(secondSync.status).toBe(200);
    expect(await secondSync.json()).toEqual({ pending: false });

    const jobRows = await sql<{ subject_opaque_id: string; status: string }[]>`
      SELECT subject_opaque_id, status
      FROM ${sql(controlSchema)}.erasure_jobs
      ORDER BY subject_opaque_id ASC
    `;
    expect(jobRows).toEqual([
      { subject_opaque_id: "usr_cancel", status: "CANCELLED" },
      { subject_opaque_id: "usr_due", status: "EXECUTING" },
      { subject_opaque_id: "usr_future", status: "WAITING_COOLDOWN" },
    ]);

    const cancelledTasks = await sql<{ status: string }[]>`
      SELECT status
      FROM ${sql(controlSchema)}.task_queue
      WHERE erasure_job_id = (
        SELECT id
        FROM ${sql(controlSchema)}.erasure_jobs
        WHERE subject_opaque_id = 'usr_cancel'
      )
    `;
    expect(cancelledTasks).toHaveLength(1);
    expect(cancelledTasks[0]?.status).toBe("FAILED");
  });

  it("cancel endpoint prevents a waiting erasure request from syncing", async () => {
    const { app } = await setup();
    const request = buildErasureRequest({ subject_opaque_id: "usr_abort", cooldown_days: 30 });

    const createResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(createResponse.status).toBe(202);

    const cancelResponse = await app.request(`/api/v1/erasure-requests/${request.idempotency_key}/cancel`, {
      method: "POST",
    });
    expect(cancelResponse.status).toBe(200);

    const syncResponse = await app.request("/api/v1/worker/sync", {
      method: "GET",
      headers: buildWorkerAuthHeaders(),
    });
    expect(syncResponse.status).toBe(200);
    expect(await syncResponse.json()).toEqual({ pending: false });
  });

  it("ingests a chained USER_VAULTED event and transitions the job to VAULTED", async () => {
    const { app, controlSchema } = await setup();
    const request = buildErasureRequest({ subject_opaque_id: "usr_worm", cooldown_days: 0 });
    const createResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const created = (await createResponse.json()) as { request_id: string; task_id: string };

    const ackResponse = await app.request(`/api/v1/worker/tasks/${created.task_id}/ack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders(),
      },
      body: JSON.stringify({
        status: "completed",
        result: { action: "vaulted" },
      }),
    });
    expect(ackResponse.status).toBe(200);

    const payload = {
      request_id: created.request_id,
      subject_opaque_id: request.subject_opaque_id,
      tenant_id: null,
      trigger_source: request.trigger_source,
      legal_framework: request.legal_framework,
      actor_opaque_id: request.actor_opaque_id,
      applied_rule_name: "PMLA_FINANCIAL",
      event_timestamp: "2026-04-19T10:00:00.000Z",
      retention_years: 10,
    };
    const idempotencyKey = `vault:${created.request_id}`;
    const currentHash = await computeCurrentHash("GENESIS", payload, idempotencyKey);

    const outboxResponse = await app.request("/api/v1/worker/outbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders(),
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        request_id: created.request_id,
        subject_opaque_id: request.subject_opaque_id,
        event_type: "USER_VAULTED",
        payload,
        previous_hash: "GENESIS",
        current_hash: currentHash,
        event_timestamp: "2026-04-19T10:00:00.000Z",
      }),
    });
    expect(outboxResponse.status).toBe(202);

    const [job] = await sql<{ status: string }[]>`
      SELECT status
      FROM ${sql(controlSchema)}.erasure_jobs
      WHERE id = ${created.request_id}
    `;
    expect(job?.status).toBe("VAULTED");
  });

  it("ingests SHRED_SUCCESS and mints a certificate of erasure", async () => {
    const { app } = await setup();
    const request = buildErasureRequest({ subject_opaque_id: "usr_cert", cooldown_days: 0 });
    const createResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const created = (await createResponse.json()) as { request_id: string; task_id: string };

    await app.request(`/api/v1/worker/tasks/${created.task_id}/ack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders(),
      },
      body: JSON.stringify({
        status: "completed",
        result: { action: "vaulted" },
      }),
    });

    const vaultPayload = {
      request_id: created.request_id,
      subject_opaque_id: request.subject_opaque_id,
      trigger_source: request.trigger_source,
      legal_framework: request.legal_framework,
      actor_opaque_id: request.actor_opaque_id,
      applied_rule_name: "PMLA_FINANCIAL",
      event_timestamp: "2026-04-19T10:00:00.000Z",
    };
    const vaultIdempotencyKey = `vault:${created.request_id}`;
    const vaultHash = await computeCurrentHash("GENESIS", vaultPayload, vaultIdempotencyKey);
    await app.request("/api/v1/worker/outbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders(),
      },
      body: JSON.stringify({
        idempotency_key: vaultIdempotencyKey,
        request_id: created.request_id,
        subject_opaque_id: request.subject_opaque_id,
        event_type: "USER_VAULTED",
        payload: vaultPayload,
        previous_hash: "GENESIS",
        current_hash: vaultHash,
        event_timestamp: "2026-04-19T10:00:00.000Z",
      }),
    });

    const shredPayload = {
      request_id: created.request_id,
      subject_opaque_id: request.subject_opaque_id,
      trigger_source: request.trigger_source,
      legal_framework: request.legal_framework,
      actor_opaque_id: request.actor_opaque_id,
      applied_rule_name: "PMLA_FINANCIAL",
      event_timestamp: "2036-04-19T10:00:00.000Z",
      shredded_at: "2036-04-19T10:00:00.000Z",
    };
    const shredIdempotencyKey = `shred:${created.request_id}`;
    const shredHash = await computeCurrentHash(vaultHash, shredPayload, shredIdempotencyKey);
    const shredResponse = await app.request("/api/v1/worker/outbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders(),
      },
      body: JSON.stringify({
        idempotency_key: shredIdempotencyKey,
        request_id: created.request_id,
        subject_opaque_id: request.subject_opaque_id,
        event_type: "SHRED_SUCCESS",
        payload: shredPayload,
        previous_hash: vaultHash,
        current_hash: shredHash,
        event_timestamp: "2036-04-19T10:00:00.000Z",
      }),
    });
    expect(shredResponse.status).toBe(202);

    const certificateResponse = await app.request(`/api/v1/certificates/${created.request_id}`);
    expect(certificateResponse.status).toBe(200);
    const certificate = (await certificateResponse.json()) as {
      request_id: string;
      subject_opaque_id: string;
      legal_framework: string;
      method: string;
    };
    expect(certificate.request_id).toBe(created.request_id);
    expect(certificate.subject_opaque_id).toBe(request.subject_opaque_id);
    expect(certificate.legal_framework).toBe(request.legal_framework);
    expect(certificate.method).toBe("CRYPTO_SHREDDING_DEK_DELETE");
  });

  it("dispatches terminal webhook payload when webhook_url is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    try {
      const { app } = await setup();
      const webhookUrl = "https://client.example.com/hooks/dpdp";
      const request = buildErasureRequest({
        subject_opaque_id: "usr_webhook",
        cooldown_days: 0,
        webhook_url: webhookUrl,
      });
      const createResponse = await app.request("/api/v1/erasure-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const created = (await createResponse.json()) as { request_id: string; task_id: string };

      await app.request(`/api/v1/worker/tasks/${created.task_id}/ack`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...buildWorkerAuthHeaders(),
        },
        body: JSON.stringify({
          status: "completed",
          result: { action: "vaulted" },
        }),
      });

      const shredPayload = {
        request_id: created.request_id,
        subject_opaque_id: request.subject_opaque_id,
        trigger_source: request.trigger_source,
        legal_framework: request.legal_framework,
        actor_opaque_id: request.actor_opaque_id,
        applied_rule_name: "PMLA_FINANCIAL",
        event_timestamp: "2036-04-19T10:00:00.000Z",
        shredded_at: "2036-04-19T10:00:00.000Z",
      };
      const shredIdempotencyKey = `shred:${created.request_id}`;
      const shredHash = await computeCurrentHash("GENESIS", shredPayload, shredIdempotencyKey);

      const shredResponse = await app.request("/api/v1/worker/outbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...buildWorkerAuthHeaders(),
        },
        body: JSON.stringify({
          idempotency_key: shredIdempotencyKey,
          request_id: created.request_id,
          subject_opaque_id: request.subject_opaque_id,
          event_type: "SHRED_SUCCESS",
          payload: shredPayload,
          previous_hash: "GENESIS",
          current_hash: shredHash,
          event_timestamp: "2036-04-19T10:00:00.000Z",
        }),
      });
      expect(shredResponse.status).toBe(202);
      expect(fetchSpy).toHaveBeenCalledWith(
        webhookUrl,
        expect.objectContaining({
          method: "POST",
          headers: { "content-type": "application/json" },
        })
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
