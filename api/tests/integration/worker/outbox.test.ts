import request from "supertest";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../../src/app";
import { sql } from "../../../src/db/index";
import { setupDatabase, teardownDatabase } from "../../../src/db/schema";

describe("POST /api/v1/worker/outbox", () => {
  const CLIENT_ID = "test-client-outbox-123";

  beforeAll(async () => {
    await setupDatabase();
  });

  afterAll(async () => {
    await teardownDatabase();
  });

  beforeEach(async () => {
    await sql`DELETE FROM worker_outbox_events`;
  });

  it("returns 400 if x-client-id is missing", async () => {
    const res = await request(app).post("/api/v1/worker/outbox").send({ event_type: "TEST", payload: {} });
    expect(res.status).toBe(400);
  });

  it("returns 400 if event_type or payload is missing", async () => {
    const res = await request(app).post("/api/v1/worker/outbox").set("x-client-id", CLIENT_ID).send({ event_type: "TEST" });
    expect(res.status).toBe(400);
  });

  it("stores the outbox event and returns 201", async () => {
    const payload = { user_hash: "abc", action: "VAULTED" };
    const res = await request(app).post("/api/v1/worker/outbox").set("x-client-id", CLIENT_ID).send({
      event_type: "VAULT_SUCCESS",
      payload,
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.event).toBeDefined();

    const events = await sql`
      SELECT * FROM worker_outbox_events
      WHERE client_id = ${CLIENT_ID}
    `;
    expect(events.length).toBe(1);
    expect(events[0]?.event_type).toBe("VAULT_SUCCESS");
    expect(events[0]?.payload).toEqual(payload);
  });

  it("deduplicates events by idempotency key", async () => {
    const payload = { user_hash: "abc", action: "VAULTED" };
    const first = await request(app).post("/api/v1/worker/outbox").set("x-client-id", CLIENT_ID).send({
      event_type: "VAULT_SUCCESS",
      payload,
      idempotency_key: "evt-1",
    });
    const second = await request(app).post("/api/v1/worker/outbox").set("x-client-id", CLIENT_ID).send({
      event_type: "VAULT_SUCCESS",
      payload,
      idempotency_key: "evt-1",
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
  });

  it("lists outbox events for a client", async () => {
    await request(app).post("/api/v1/worker/outbox").set("x-client-id", CLIENT_ID).send({ event_type: "A", payload: { n: 1 } });
    await request(app).post("/api/v1/worker/outbox").set("x-client-id", CLIENT_ID).send({ event_type: "B", payload: { n: 2 } });

    const res = await request(app).get("/api/v1/worker/outbox/events?limit=2&offset=0").set("x-client-id", CLIENT_ID);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events.length).toBe(2);
  });
});
