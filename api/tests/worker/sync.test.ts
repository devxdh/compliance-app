import request from "supertest";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app";
import { sql } from "../../src/db/index";
import { eventBus } from "../../src/utils/event-bus";
import { setupDatabase, teardownDatabase } from "../../src/db/schema";

describe("GET /api/v1/worker/sync", () => {
  const CLIENT_ID = "test-client-123";

  beforeAll(async () => {
    await setupDatabase();
  });

  afterAll(async () => {
    await teardownDatabase();
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM pending_tasks WHERE client_id = ${CLIENT_ID}`;
  });

  it("should return 400 if x-client-id is missing", async () => {
    const res = await request(app).get("/api/v1/worker/sync");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("x-client-id header is required");
  });

  it("should return a task immediately if one is pending (fast path)", async () => {
    await sql`
      INSERT INTO pending_tasks (client_id, task_type, payload)
      VALUES (${CLIENT_ID}, 'VAULT_DATA', '{"user_id": 1}')
    `;

    const res = await request(app).get("/api/v1/worker/sync").set("x-client-id", CLIENT_ID);

    expect(res.status).toBe(200);
    expect(res.body.pending).toBe(true);
    expect(res.body.task).toBeDefined();
    expect(res.body.task.task_type).toBe("VAULT_DATA");

    const tasks = await sql`SELECT status FROM pending_tasks WHERE id = ${res.body.task.id}`;
    expect(tasks[0]?.status).toBe("claimed");
  });

  it("should resolve immediately when a new event is emitted via Event Bus", async () => {
    const syncPromise = request(app).get("/api/v1/worker/sync").set("x-client-id", CLIENT_ID);

    setTimeout(() => {
      eventBus.emit(`task_ready_${CLIENT_ID}`, { id: "evt-1", task_type: "NOTIFY_USER" });
    }, 100);

    const res = await syncPromise;

    expect(res.status).toBe(200);
    expect(res.body.pending).toBe(true);
    expect(res.body.task).toBeDefined();
    expect(res.body.task.task_type).toBe("NOTIFY_USER");
  });
});
