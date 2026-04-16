import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "../src/db/migrations";
import { calculateRetryDelayMs, processOutbox } from "../src/network/outbox";
import type { OutboxEvent } from "../src/network/outbox";
import { createTestSql, dropSchemas, uniqueSchema } from "./helpers/db";

describe("Network Outbox Relay", () => {
  let sql: postgres.Sql;
  const schemasToDrop: string[] = [];

  beforeAll(() => {
    sql = createTestSql();
  });

  afterAll(async () => {
    await dropSchemas(sql, ...schemasToDrop);
    await sql.end();
  });

  async function prepare() {
    const engineSchema = uniqueSchema("outbox_engine");
    schemasToDrop.push(engineSchema);
    await dropSchemas(sql, engineSchema);
    await runMigrations(sql, engineSchema);
    return { engineSchema };
  }

  async function seedEvent(
    engineSchema: string,
    idempotencyKey: string,
    userHash: string,
    eventType: string,
    nextAttemptAt: Date = new Date()
  ) {
    await sql`
      INSERT INTO ${sql(engineSchema)}.outbox (
        idempotency_key,
        user_uuid_hash,
        event_type,
        payload,
        status,
        attempt_count,
        next_attempt_at,
        created_at,
        updated_at
      )
      VALUES (
        ${idempotencyKey},
        ${userHash},
        ${eventType},
        '{}'::jsonb,
        'pending',
        0,
        ${nextAttemptAt},
        NOW(),
        NOW()
      )
    `;
  }

  it("processes due events and marks them as processed", async () => {
    const { engineSchema } = await prepare();
    await seedEvent(engineSchema, "event-1", "user1", "TEST_EVENT");
    await seedEvent(engineSchema, "event-2", "user2", "TEST_EVENT");

    const result = await processOutbox(sql, async () => true, { engineSchema, batchSize: 10 });
    expect(result).toEqual({
      claimed: 2,
      processed: 2,
      failed: 0,
      deadLettered: 0,
    });

    const rows = await sql`SELECT status, processed_at FROM ${sql(engineSchema)}.outbox ORDER BY idempotency_key ASC`;
    expect(rows.every((row) => row.status === "processed")).toBe(true);
    expect(rows.every((row) => row.processed_at !== null)).toBe(true);
  });

  it("requeues failed events with backoff and error context", async () => {
    const { engineSchema } = await prepare();
    const now = new Date("2026-04-15T00:00:00.000Z");
    await seedEvent(engineSchema, "event-3", "user3", "FAIL_EVENT", now);

    const result = await processOutbox(
      sql,
      async () => {
        throw new Error("Network Error");
      },
      {
        engineSchema,
        batchSize: 10,
        now,
        baseBackoffMs: 500,
        maxAttempts: 3,
      }
    );

    expect(result).toEqual({
      claimed: 1,
      processed: 0,
      failed: 1,
      deadLettered: 0,
    });

    const [row] = await sql`
      SELECT status, attempt_count, next_attempt_at, last_error
      FROM ${sql(engineSchema)}.outbox
      WHERE idempotency_key = 'event-3'
    `;

    expect(row?.status).toBe("pending");
    expect(row?.attempt_count).toBe(1);
    expect(row?.last_error).toContain("Network Error");
    expect(new Date(row!.next_attempt_at).getTime()).toBe(now.getTime() + calculateRetryDelayMs(1, 500));
  });

  it("moves an event to dead_letter after the maximum retry count is reached", async () => {
    const { engineSchema } = await prepare();
    await seedEvent(engineSchema, "event-4", "user4", "FAIL_EVENT");

    const result = await processOutbox(
      sql,
      async () => {
        throw new Error("Permanent Failure");
      },
      {
        engineSchema,
        batchSize: 10,
        maxAttempts: 1,
      }
    );

    expect(result).toEqual({
      claimed: 1,
      processed: 0,
      failed: 1,
      deadLettered: 1,
    });

    const [row] = await sql`
      SELECT status, attempt_count, last_error
      FROM ${sql(engineSchema)}.outbox
      WHERE idempotency_key = 'event-4'
    `;

    expect(row?.status).toBe("dead_letter");
    expect(row?.attempt_count).toBe(1);
    expect(row?.last_error).toContain("Permanent Failure");
  });

  it("handles concurrent workers without duplicating event delivery", async () => {
    const { engineSchema } = await prepare();
    await seedEvent(engineSchema, "event-5", "user5", "CONCURRENT");
    await seedEvent(engineSchema, "event-6", "user6", "CONCURRENT");
    await seedEvent(engineSchema, "event-7", "user7", "CONCURRENT");

    const deliveredIds = new Set<string>();

    const syncFn = async (event: OutboxEvent) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (deliveredIds.has(event.id)) {
        throw new Error(`Duplicate delivery for ${event.id}`);
      }
      deliveredIds.add(event.id);
      return true;
    };

    const [a, b, c] = await Promise.all([
      processOutbox(sql, syncFn, { engineSchema, batchSize: 1 }),
      processOutbox(sql, syncFn, { engineSchema, batchSize: 1 }),
      processOutbox(sql, syncFn, { engineSchema, batchSize: 1 }),
    ]);

    expect(a.processed + b.processed + c.processed).toBe(3);
    expect(deliveredIds.size).toBe(3);
  });

  it("reclaims an event whose lease has already expired", async () => {
    const { engineSchema } = await prepare();

    await sql`
      INSERT INTO ${sql(engineSchema)}.outbox (
        idempotency_key,
        user_uuid_hash,
        event_type,
        payload,
        status,
        attempt_count,
        lease_token,
        lease_expires_at,
        next_attempt_at,
        created_at,
        updated_at
      )
      VALUES (
        'event-8',
        'user8',
        'LEASED_EVENT',
        '{}'::jsonb,
        'leased',
        2,
        gen_random_uuid(),
        NOW() - INTERVAL '10 minutes',
        NOW() - INTERVAL '10 minutes',
        NOW(),
        NOW()
      )
    `;

    const result = await processOutbox(sql, async () => true, { engineSchema, batchSize: 10 });
    expect(result.processed).toBe(1);

    const [row] = await sql`
      SELECT status, processed_at
      FROM ${sql(engineSchema)}.outbox
      WHERE idempotency_key = 'event-8'
    `;

    expect(row?.status).toBe("processed");
    expect(row?.processed_at).toBeDefined();
  });
});
