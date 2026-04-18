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

    const syncResponse = await app.request("/api/v1/worker/sync", {
      method: "GET",
      headers: { "x-client-id": "worker-1" },
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
      headers: { "content-type": "application/json", "x-client-id": "worker-1" },
      body: JSON.stringify({
        status: "completed",
        result: { action: "vaulted" },
      }),
    });
    expect(ackResponse.status).toBe(200);

    for (const eventType of ["USER_VAULTED", "NOTIFICATION_SENT", "SHRED_SUCCESS"] as const) {
      const outboxResponse = await app.request("/api/v1/worker/outbox", {
        method: "POST",
        headers: { "content-type": "application/json", "x-client-id": "worker-1" },
        body: JSON.stringify({
          idempotencyKey: `${eventType.toLowerCase()}:${created.requestId}`,
          requestId: created.requestId,
          targetHash,
          eventType,
          payload: { eventType },
          eventTimestamp: "2026-04-18T00:00:00.000Z",
        }),
      });
      expect(outboxResponse.status).toBe(202);
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
