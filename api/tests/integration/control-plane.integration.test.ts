import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createApp } from "../../src/app";
import { createEd25519Signer } from "../../src/crypto/coe";
import { migrateApiSchema } from "../../src/db/migrations";
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
      maxOutboxPayloadBytes: 2048,
    });

    return { app, controlSchema };
  }

  interface CreatedRequestResponse {
    requestId: string;
    taskId: string;
    acceptedAt: string;
  }

  interface SyncResponse {
    pending: boolean;
    task?: {
      id: string;
      task_type: "VAULT_USER";
      payload: { userId: number };
    };
  }

  function buildWorkerAuthHeaders(clientId: string, token: string) {
    return {
      "x-client-id": clientId,
      authorization: `Bearer ${token}`,
    };
  }

  async function computeCurrentHash(previousHash: string, payload: unknown): Promise<string> {
    const data = new TextEncoder().encode(`${previousHash}${JSON.stringify(payload)}`);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
    return Buffer.from(digest).toString("hex");
  }

  interface CertificateResponse {
    requestId: string;
    targetHash: string;
    method: string;
    legalFramework: string;
    shreddedAt: string;
    signature: {
      algorithm: string;
      keyId: string;
      signatureBase64: string;
      publicKeySpkiBase64: string;
    };
  }

  it("creates request, dispatches task, processes worker callbacks, and mints CoE on shred success", async () => {
    const { app } = await setup();
    const targetHash = "aa".repeat(32);

    const createResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "tenant_a",
        targetHash,
        legalBasis: "DPDP_SEC_8_7",
        retentionYears: 5,
      }),
    });

    expect(createResponse.status).toBe(202);
    const created = (await createResponse.json()) as CreatedRequestResponse;
    expect(created.requestId).toBeTruthy();
    expect(created.taskId).toBeTruthy();
    expect(created.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(created.taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const syncResponse = await app.request("/api/v1/worker/sync", {
      method: "GET",
      headers: buildWorkerAuthHeaders("tenant_a", "worker-secret"),
    });
    expect(syncResponse.status).toBe(200);
    const syncPayload = (await syncResponse.json()) as SyncResponse;
    expect(syncPayload.pending).toBe(true);
    expect(syncPayload.task).toBeTruthy();
    if (!syncPayload.task) {
      throw new Error("expected pending worker task");
    }
    expect(syncPayload.task.task_type).toBe("VAULT_USER");
    expect(syncPayload.task.payload.userId).toBe(1042);

    const ackResponse = await app.request(`/api/v1/worker/tasks/${syncPayload.task.id}/ack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders("tenant_a", "worker-secret"),
      },
      body: JSON.stringify({
        status: "completed",
        result: { action: "vaulted" },
      }),
    });
    expect(ackResponse.status).toBe(200);

    let previousHash = "GENESIS";
    for (const eventType of ["USER_VAULTED", "NOTIFICATION_SENT", "SHRED_SUCCESS"] as const) {
      const payload = { eventType };
      const currentHash = await computeCurrentHash(previousHash, payload);
      const outboxResponse = await app.request("/api/v1/worker/outbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...buildWorkerAuthHeaders("tenant_a", "worker-secret"),
        },
        body: JSON.stringify({
          idempotencyKey: `${eventType.toLowerCase()}:${created.requestId}`,
          requestId: created.requestId,
          targetHash,
          eventType,
          payload,
          previousHash,
          currentHash,
          eventTimestamp: "2026-04-18T00:00:00.000Z",
        }),
      });
      expect(outboxResponse.status).toBe(202);
      previousHash = currentHash;
    }

    const certificateResponse = await app.request(`/api/v1/certificates/${created.requestId}`);
    expect(certificateResponse.status).toBe(200);
    const certificatePayload = (await certificateResponse.json()) as CertificateResponse;

    expect(certificatePayload.requestId).toBe(created.requestId);
    expect(certificatePayload.targetHash).toBe(targetHash);
    expect(certificatePayload.method).toBe("CRYPTO_SHREDDING_DEK_DELETE");
    expect(certificatePayload.signature.algorithm).toBe("Ed25519");
    expect(certificatePayload.signature.signatureBase64).toBeTruthy();
  });

  it("rejects non-zero-trust request bodies containing undeclared fields", async () => {
    const { app } = await setup();
    const response = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "tenant_a",
        targetHash: "bb".repeat(32),
        legalBasis: "DPDP_SEC_8_7",
        retentionYears: 5,
        email: "pii@should.not.pass",
      }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects worker sync when auth headers are missing or invalid", async () => {
    const { app } = await setup();
    await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "tenant_auth",
        targetHash: "dd".repeat(32),
        legalBasis: "DPDP_SEC_8_7",
        retentionYears: 5,
      }),
    });

    const missingAuth = await app.request("/api/v1/worker/sync", {
      method: "GET",
      headers: { "x-client-id": "tenant_auth" },
    });
    expect(missingAuth.status).toBe(400);

    const wrongAuth = await app.request("/api/v1/worker/sync", {
      method: "GET",
      headers: buildWorkerAuthHeaders("tenant_auth", "wrong-secret"),
    });
    expect(wrongAuth.status).toBe(401);
  });

  it("rejects outbox payloads with invalid hash chaining or oversized payloads", async () => {
    const { app } = await setup();
    const createResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "tenant_hash",
        targetHash: "ee".repeat(32),
        legalBasis: "DPDP_SEC_8_7",
        retentionYears: 5,
      }),
    });
    const created = (await createResponse.json()) as CreatedRequestResponse;

    const badHashResponse = await app.request("/api/v1/worker/outbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders("tenant_hash", "worker-secret"),
      },
      body: JSON.stringify({
        idempotencyKey: `bad-hash:${created.requestId}`,
        requestId: created.requestId,
        targetHash: "ee".repeat(32),
        eventType: "USER_VAULTED",
        payload: { eventType: "USER_VAULTED" },
        previousHash: "GENESIS",
        currentHash: "0".repeat(64),
        eventTimestamp: "2026-04-18T00:00:00.000Z",
      }),
    });
    expect(badHashResponse.status).toBe(400);

    const oversizedPayload = "x".repeat(5000);
    const oversizedHash = await computeCurrentHash("GENESIS", oversizedPayload);
    const oversizedResponse = await app.request("/api/v1/worker/outbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders("tenant_hash", "worker-secret"),
      },
      body: JSON.stringify({
        idempotencyKey: `oversized:${created.requestId}`,
        requestId: created.requestId,
        targetHash: "ee".repeat(32),
        eventType: "USER_VAULTED",
        payload: oversizedPayload,
        previousHash: "GENESIS",
        currentHash: oversizedHash,
        eventTimestamp: "2026-04-18T00:00:00.000Z",
      }),
    });
    expect(oversizedResponse.status).toBe(400);
  });

  it("rejects worker outbox ingestion when credentials are invalid", async () => {
    const { app } = await setup();
    const createResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "tenant_outbox_auth",
        targetHash: "ab".repeat(32),
        legalBasis: "DPDP_SEC_8_7",
        retentionYears: 5,
      }),
    });
    const created = (await createResponse.json()) as CreatedRequestResponse;

    const payload = { eventType: "USER_VAULTED" };
    const currentHash = await computeCurrentHash("GENESIS", payload);
    const response = await app.request("/api/v1/worker/outbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders("tenant_outbox_auth", "wrong-secret"),
      },
      body: JSON.stringify({
        idempotencyKey: `bad-auth:${created.requestId}`,
        requestId: created.requestId,
        targetHash: "ab".repeat(32),
        eventType: "USER_VAULTED",
        payload,
        previousHash: "GENESIS",
        currentHash,
        eventTimestamp: "2026-04-18T00:00:00.000Z",
      }),
    });

    expect(response.status).toBe(401);
  });

  it("accepts equivalent outbox retries as idempotent replays", async () => {
    const { app } = await setup();
    const targetHash = "fa".repeat(32);
    const createResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "tenant_replay",
        targetHash,
        legalBasis: "DPDP_SEC_8_7",
        retentionYears: 5,
      }),
    });
    const created = (await createResponse.json()) as CreatedRequestResponse;

    const payload = { eventType: "USER_VAULTED" };
    const currentHash = await computeCurrentHash("GENESIS", payload);
    const eventBody = {
      idempotencyKey: `retry:${created.requestId}`,
      requestId: created.requestId,
      targetHash,
      eventType: "USER_VAULTED",
      payload,
      previousHash: "GENESIS",
      currentHash,
      eventTimestamp: "2026-04-18T00:00:00.000Z",
    };

    const first = await app.request("/api/v1/worker/outbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders("tenant_replay", "worker-secret"),
      },
      body: JSON.stringify(eventBody),
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ accepted: true, idempotentReplay: false });

    const replay = await app.request("/api/v1/worker/outbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders("tenant_replay", "worker-secret"),
      },
      body: JSON.stringify(eventBody),
    });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ accepted: true, idempotentReplay: true });
  });

  it("returns 404 when CoE is requested before shred completion", async () => {
    const { app } = await setup();

    const createResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "tenant_a",
        targetHash: "cc".repeat(32),
        legalBasis: "DPDP_SEC_8_7",
        retentionYears: 5,
      }),
    });
    const created = (await createResponse.json()) as CreatedRequestResponse;

    const certificateResponse = await app.request(`/api/v1/certificates/${created.requestId}`);
    expect(certificateResponse.status).toBe(404);
  });
});
