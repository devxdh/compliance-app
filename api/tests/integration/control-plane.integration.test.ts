import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { createApp } from "../../src/app";
import { createEd25519Signer, verifyEd25519Signature } from "../../src/crypto/coe";
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

  async function setup(
    overrides: {
      now?: () => Date;
      taskMaxAttempts?: number;
      taskBaseBackoffMs?: number;
    } = {}
  ) {
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
      taskMaxAttempts: overrides.taskMaxAttempts,
      taskBaseBackoffMs: overrides.taskBaseBackoffMs,
      now: overrides.now,
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

  async function computeCurrentHash(previousHash: string, payload: unknown): Promise<string> {
    return computeWormHash(previousHash, payload);
  }

  it("rejects undeclared PII fields, direct identifiers, and missing mandatory actor metadata", async () => {
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

    const emailSubjectResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        buildErasureRequest({
          subject_opaque_id: "alice@example.com",
        })
      ),
    });
    expect(emailSubjectResponse.status).toBe(400);

    const phoneActorResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        buildErasureRequest({
          actor_opaque_id: "+91 9876543210",
        })
      ),
    });
    expect(phoneActorResponse.status).toBe(400);

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

  it("reuses the same cooldown timer on idempotent create replay", async () => {
    const { app, controlSchema } = await setup();
    const request = buildErasureRequest({
      subject_opaque_id: "usr_idempotent",
      cooldown_days: 30,
    });

    const firstResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(firstResponse.status).toBe(202);
    const firstBody = (await firstResponse.json()) as {
      request_id: string;
      task_id: string;
      idempotent_replay: boolean;
    };
    expect(firstBody.idempotent_replay).toBe(false);

    const replayResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(replayResponse.status).toBe(202);
    const replayBody = (await replayResponse.json()) as {
      request_id: string;
      task_id: string;
      idempotent_replay: boolean;
    };
    expect(replayBody.request_id).toBe(firstBody.request_id);
    expect(replayBody.task_id).toBe(firstBody.task_id);
    expect(replayBody.idempotent_replay).toBe(true);

    const [counts] = await sql<{ job_count: number; task_count: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM ${sql(controlSchema)}.erasure_jobs WHERE idempotency_key = ${request.idempotency_key}::uuid) AS job_count,
        (SELECT COUNT(*)::int FROM ${sql(controlSchema)}.task_queue WHERE erasure_job_id = ${firstBody.request_id}) AS task_count
    `;
    expect(counts).toEqual({
      job_count: 1,
      task_count: 1,
    });
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

  it("requeues retryable task failures with exponential backoff before redispatch", async () => {
    let now = new Date("2026-04-19T10:00:00.000Z");
    const { app, controlSchema } = await setup({
      now: () => now,
      taskMaxAttempts: 3,
      taskBaseBackoffMs: 1000,
    });

    const request = buildErasureRequest({ subject_opaque_id: "usr_retry_task", cooldown_days: 0 });
    const createResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const created = (await createResponse.json()) as { request_id: string; task_id: string };

    const syncResponse = await app.request("/api/v1/worker/sync", {
      method: "GET",
      headers: buildWorkerAuthHeaders(),
    });
    expect(syncResponse.status).toBe(200);

    const ackResponse = await app.request(`/api/v1/worker/tasks/${created.task_id}/ack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders(),
      },
      body: JSON.stringify({
        status: "failed",
        result: {
          error: {
            code: "DPDP_DB_SERIALIZATION_FAILURE",
            title: "Serialization failure",
            detail: "Concurrent writer forced rollback.",
            category: "concurrency",
            retryable: true,
            fatal: false,
          },
        },
      }),
    });
    expect(ackResponse.status).toBe(200);
    expect(await ackResponse.json()).toEqual(
      expect.objectContaining({
        ok: true,
        task_id: created.task_id,
        status: "QUEUED",
      })
    );

    const [taskAfterFailure] = await sql<{
      status: string;
      attempt_count: number;
      next_attempt_at: Date;
    }[]>`
      SELECT status, attempt_count, next_attempt_at
      FROM ${sql(controlSchema)}.task_queue
      WHERE id = ${created.task_id}
    `;
    expect(taskAfterFailure?.status).toBe("QUEUED");
    expect(taskAfterFailure?.attempt_count).toBe(1);
    expect(new Date(taskAfterFailure!.next_attempt_at).toISOString()).toBe("2026-04-19T10:00:01.000Z");

    const beforeDueSync = await app.request("/api/v1/worker/sync", {
      method: "GET",
      headers: buildWorkerAuthHeaders(),
    });
    expect(beforeDueSync.status).toBe(200);
    expect(await beforeDueSync.json()).toEqual({ pending: false });

    now = new Date("2026-04-19T10:00:01.000Z");
    const afterDueSync = await app.request("/api/v1/worker/sync", {
      method: "GET",
      headers: buildWorkerAuthHeaders(),
    });
    expect(afterDueSync.status).toBe(200);
    expect(await afterDueSync.json()).toEqual(
      expect.objectContaining({
        pending: true,
        task: expect.objectContaining({
          id: created.task_id,
        }),
      })
    );
  });

  it("dead-letters non-retryable task failures and marks the job as failed", async () => {
    const { app, controlSchema } = await setup({
      now: () => new Date("2026-04-19T10:00:00.000Z"),
      taskMaxAttempts: 3,
      taskBaseBackoffMs: 1000,
    });

    const request = buildErasureRequest({ subject_opaque_id: "usr_dead_letter", cooldown_days: 0 });
    const createResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const created = (await createResponse.json()) as { request_id: string; task_id: string };

    await app.request("/api/v1/worker/sync", {
      method: "GET",
      headers: buildWorkerAuthHeaders(),
    });

    const ackResponse = await app.request(`/api/v1/worker/tasks/${created.task_id}/ack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders(),
      },
      body: JSON.stringify({
        status: "failed",
        result: {
          error: {
            code: "DPDP_TASK_PAYLOAD_INVALID",
            title: "Invalid task payload",
            detail: "Opaque identifier is malformed.",
            category: "validation",
            retryable: false,
            fatal: false,
          },
        },
      }),
    });
    expect(ackResponse.status).toBe(200);
    expect(await ackResponse.json()).toEqual(
      expect.objectContaining({
        ok: true,
        task_id: created.task_id,
        status: "DEAD_LETTER",
      })
    );

    const [taskRow] = await sql<{
      status: string;
      attempt_count: number;
      dead_lettered_at: Date | null;
    }[]>`
      SELECT status, attempt_count, dead_lettered_at
      FROM ${sql(controlSchema)}.task_queue
      WHERE id = ${created.task_id}
    `;
    expect(taskRow).toEqual({
      status: "DEAD_LETTER",
      attempt_count: 1,
      dead_lettered_at: new Date("2026-04-19T10:00:00.000Z"),
    });

    const [jobRow] = await sql<{ status: string }[]>`
      SELECT status
      FROM ${sql(controlSchema)}.erasure_jobs
      WHERE id = ${created.request_id}
    `;
    expect(jobRow?.status).toBe("FAILED");
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
      notification_due_at: "2036-04-17T10:00:00.000Z",
      retention_expiry: "2036-04-19T10:00:00.000Z",
    };
    const idempotencyKey = `vault:${created.request_id}`;
    const currentHash = await computeCurrentHash("GENESIS", payload);

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

    const [job] = await sql<{
      status: string;
      notification_due_at: Date | null;
      shred_due_at: Date | null;
    }[]>`
      SELECT status, notification_due_at, shred_due_at
      FROM ${sql(controlSchema)}.erasure_jobs
      WHERE id = ${created.request_id}
    `;
    expect(job?.status).toBe("VAULTED");
    expect(job?.notification_due_at?.toISOString()).toBe("2036-04-17T10:00:00.000Z");
    expect(job?.shred_due_at?.toISOString()).toBe("2036-04-19T10:00:00.000Z");
  });

  it("materializes a NOTIFY_USER task after USER_VAULTED reaches notification_due_at", async () => {
    const now = new Date("2036-04-17T10:00:00.000Z");
    const { app, controlSchema } = await setup({ now: () => now });
    const request = buildErasureRequest({ subject_opaque_id: "usr_notice_due", cooldown_days: 0 });

    const createResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const created = (await createResponse.json()) as { request_id: string; task_id: string };

    const leaseResponse = await app.request("/api/v1/worker/sync", {
      method: "GET",
      headers: buildWorkerAuthHeaders(),
    });
    expect(leaseResponse.status).toBe(200);

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
      tenant_id: null,
      trigger_source: request.trigger_source,
      legal_framework: request.legal_framework,
      actor_opaque_id: request.actor_opaque_id,
      applied_rule_name: "PMLA_FINANCIAL",
      event_timestamp: "2026-04-19T10:00:00.000Z",
      retention_years: 10,
      notification_due_at: "2036-04-17T10:00:00.000Z",
      retention_expiry: "2036-04-19T10:00:00.000Z",
    };
    const vaultHash = await computeCurrentHash("GENESIS", vaultPayload);
    const vaultResponse = await app.request("/api/v1/worker/outbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders(),
      },
      body: JSON.stringify({
        idempotency_key: `vault:${created.request_id}`,
        request_id: created.request_id,
        subject_opaque_id: request.subject_opaque_id,
        event_type: "USER_VAULTED",
        payload: vaultPayload,
        previous_hash: "GENESIS",
        current_hash: vaultHash,
        event_timestamp: "2026-04-19T10:00:00.000Z",
      }),
    });
    expect(vaultResponse.status).toBe(202);

    const syncResponse = await app.request("/api/v1/worker/sync", {
      method: "GET",
      headers: buildWorkerAuthHeaders(),
    });
    expect(syncResponse.status).toBe(200);
    expect(await syncResponse.json()).toEqual(
      expect.objectContaining({
        pending: true,
        task: expect.objectContaining({
          task_type: "NOTIFY_USER",
          payload: expect.objectContaining({
            request_id: created.request_id,
            subject_opaque_id: request.subject_opaque_id,
          }),
        }),
      })
    );

    const [taskRow] = await sql<{ task_type: string; status: string }[]>`
      SELECT task_type, status
      FROM ${sql(controlSchema)}.task_queue
      WHERE erasure_job_id = ${created.request_id}
        AND task_type = 'NOTIFY_USER'
    `;
    expect(taskRow?.task_type).toBe("NOTIFY_USER");
    expect(taskRow?.status).toBe("DISPATCHED");
  });

  it("materializes a SHRED_USER task after NOTIFICATION_SENT reaches retention expiry", async () => {
    const now = new Date("2036-04-19T10:00:00.000Z");
    const { app, controlSchema } = await setup({ now: () => now });
    const request = buildErasureRequest({ subject_opaque_id: "usr_shred_due", cooldown_days: 0 });

    const createResponse = await app.request("/api/v1/erasure-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const created = (await createResponse.json()) as { request_id: string; task_id: string };

    const leaseResponse = await app.request("/api/v1/worker/sync", {
      method: "GET",
      headers: buildWorkerAuthHeaders(),
    });
    expect(leaseResponse.status).toBe(200);

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
      notification_due_at: "2036-04-17T10:00:00.000Z",
      retention_expiry: "2036-04-19T10:00:00.000Z",
    };
    const vaultHash = await computeCurrentHash("GENESIS", vaultPayload);
    await app.request("/api/v1/worker/outbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders(),
      },
      body: JSON.stringify({
        idempotency_key: `vault:${created.request_id}`,
        request_id: created.request_id,
        subject_opaque_id: request.subject_opaque_id,
        event_type: "USER_VAULTED",
        payload: vaultPayload,
        previous_hash: "GENESIS",
        current_hash: vaultHash,
        event_timestamp: "2026-04-19T10:00:00.000Z",
      }),
    });

    const noticePayload = {
      request_id: created.request_id,
      subject_opaque_id: request.subject_opaque_id,
      trigger_source: request.trigger_source,
      legal_framework: request.legal_framework,
      actor_opaque_id: request.actor_opaque_id,
      applied_rule_name: "PMLA_FINANCIAL",
      event_timestamp: "2036-04-17T10:00:00.000Z",
      sent_at: "2036-04-17T10:00:00.000Z",
    };
    const noticeHash = await computeCurrentHash(vaultHash, noticePayload);
    const noticeResponse = await app.request("/api/v1/worker/outbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildWorkerAuthHeaders(),
      },
      body: JSON.stringify({
        idempotency_key: `notice:${created.request_id}`,
        request_id: created.request_id,
        subject_opaque_id: request.subject_opaque_id,
        event_type: "NOTIFICATION_SENT",
        payload: noticePayload,
        previous_hash: vaultHash,
        current_hash: noticeHash,
        event_timestamp: "2036-04-17T10:00:00.000Z",
      }),
    });
    expect(noticeResponse.status).toBe(202);

    const syncResponse = await app.request("/api/v1/worker/sync", {
      method: "GET",
      headers: buildWorkerAuthHeaders(),
    });
    expect(syncResponse.status).toBe(200);
    expect(await syncResponse.json()).toEqual(
      expect.objectContaining({
        pending: true,
        task: expect.objectContaining({
          task_type: "SHRED_USER",
          payload: expect.objectContaining({
            request_id: created.request_id,
            subject_opaque_id: request.subject_opaque_id,
          }),
        }),
      })
    );

    const [taskRow] = await sql<{ task_type: string; status: string }[]>`
      SELECT task_type, status
      FROM ${sql(controlSchema)}.task_queue
      WHERE erasure_job_id = ${created.request_id}
        AND task_type = 'SHRED_USER'
    `;
    expect(taskRow?.task_type).toBe("SHRED_USER");
    expect(taskRow?.status).toBe("DISPATCHED");
  });

  it("ingests SHRED_SUCCESS and mints a certificate of erasure", async () => {
    const { app, controlSchema } = await setup();
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
      notification_due_at: "2036-04-17T10:00:00.000Z",
      retention_expiry: "2036-04-19T10:00:00.000Z",
    };
    const vaultIdempotencyKey = `vault:${created.request_id}`;
    const vaultHash = await computeCurrentHash("GENESIS", vaultPayload);
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
    const shredHash = await computeCurrentHash(vaultHash, shredPayload);
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
      final_worm_hash: string;
    };
    expect(certificate.request_id).toBe(created.request_id);
    expect(certificate.subject_opaque_id).toBe(request.subject_opaque_id);
    expect(certificate.legal_framework).toBe(request.legal_framework);
    expect(certificate.method).toBe("CRYPTO_SHREDDING_DEK_DELETE");
    expect(certificate.final_worm_hash).toBe(shredHash);

    const [storedCertificate] = await sql<{
      payload: Record<string, unknown>;
      signature_base64: string;
      public_key_spki_base64: string;
    }[]>`
      SELECT payload, signature_base64, public_key_spki_base64
      FROM ${sql(controlSchema)}.certificates
      WHERE request_id = ${created.request_id}
    `;
    expect(storedCertificate?.payload.final_worm_hash).toBe(shredHash);
    expect(
      await verifyEd25519Signature(
        storedCertificate!.public_key_spki_base64,
        storedCertificate!.signature_base64,
        storedCertificate!.payload
      )
    ).toBe(true);
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
      const shredHash = await computeCurrentHash("GENESIS", shredPayload);

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
          headers: expect.objectContaining({ "content-type": "application/json" }),
        })
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("retries terminal webhook delivery on idempotent SHRED_SUCCESS replay", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "bad gateway" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );

    try {
      const { app } = await setup();
      const request = buildErasureRequest({
        subject_opaque_id: "usr_webhook_replay",
        cooldown_days: 0,
        webhook_url: "https://client.example.com/hooks/replay",
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
      const shredEvent = {
        idempotency_key: `shred:${created.request_id}`,
        request_id: created.request_id,
        subject_opaque_id: request.subject_opaque_id,
        event_type: "SHRED_SUCCESS",
        payload: shredPayload,
        previous_hash: "GENESIS",
        current_hash: await computeCurrentHash("GENESIS", shredPayload),
        event_timestamp: "2036-04-19T10:00:00.000Z",
      };

      const firstResponse = await app.request("/api/v1/worker/outbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...buildWorkerAuthHeaders(),
        },
        body: JSON.stringify(shredEvent),
      });
      expect(firstResponse.status).toBe(502);

      const replayResponse = await app.request("/api/v1/worker/outbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...buildWorkerAuthHeaders(),
        },
        body: JSON.stringify(shredEvent),
      });
      expect(replayResponse.status).toBe(202);
      expect(await replayResponse.json()).toEqual({
        accepted: true,
        idempotent_replay: true,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
