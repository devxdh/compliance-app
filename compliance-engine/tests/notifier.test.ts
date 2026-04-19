import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { dispatchPreErasureNotice } from "../src/engine/notifier";
import type { MockMailer } from "../src/engine/notifier";
import { vaultUser } from "../src/engine/vault";
import { runMigrations } from "../src/db/migrations";
import {
  TEST_SECRETS,
  createTestSql,
  dropSchemas,
  insertUser,
  prepareWorkerSchemas,
  uniqueSchema,
} from "./helpers/db";

describe("Notification Handshake Engine", () => {
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
    const appSchema = uniqueSchema("notify_app");
    const engineSchema = uniqueSchema("notify_engine");
    schemasToDrop.push(appSchema, engineSchema);
    await prepareWorkerSchemas(sql, appSchema, engineSchema, { withDependencies: true });
    return { appSchema, engineSchema };
  }

  async function seedVaultedUser(appSchema: string, engineSchema: string) {
    const vaultAt = new Date("2020-01-01T00:00:00.000Z");
    const userId = await insertUser(sql, appSchema, "notify.me@example.com", "Notify Me");
    await vaultUser(sql, userId, TEST_SECRETS, {
      appSchema,
      engineSchema,
      now: vaultAt,
      defaultRetentionYears: 1,
      noticeWindowHours: 48,
      rootTable: "users",
      rootIdColumn: "id",
      rootPiiColumns: {
        email: "HMAC",
        full_name: "STATIC_MASK",
      },
      satelliteTargets: [],
    });
    return { userId, vaultAt };
  }

  it("decrypts PII, dispatches the notice, and records the outbox event when the notice window is open", async () => {
    const { appSchema, engineSchema } = await prepare();
    const { userId } = await seedVaultedUser(appSchema, engineSchema);
    const sendAt = new Date("2020-12-30T00:00:00.000Z");

    const mailer: MockMailer = {
      sendEmail: vi.fn().mockResolvedValue(undefined),
    };

    const result = await dispatchPreErasureNotice(sql, userId, TEST_SECRETS, mailer, {
      appSchema,
      engineSchema,
      now: sendAt,
    });

    expect(result.action).toBe("sent");
    expect(mailer.sendEmail).toHaveBeenCalledTimes(1);
    expect(mailer.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "notify.me@example.com",
        subject: "Notice of Permanent Data Erasure",
        body: expect.stringContaining("Dear Notify Me"),
        idempotencyKey: expect.stringContaining(`notice:${appSchema}:users:${userId}:`),
      })
    );

    const [vaultRow] = await sql`
      SELECT notification_sent_at
      FROM ${sql(engineSchema)}.pii_vault
      WHERE root_schema = ${appSchema}
        AND root_table = 'users'
        AND root_id = ${userId.toString()}
    `;
    const outboxRows = await sql`
      SELECT *
      FROM ${sql(engineSchema)}.outbox
      WHERE idempotency_key = ${`notice:${appSchema}:users:${userId}`}
    `;

    expect(vaultRow?.notification_sent_at).toBeDefined();
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.event_type).toBe("NOTIFICATION_SENT");
  });

  it("returns not_due and does not send email before the notice window opens", async () => {
    const { appSchema, engineSchema } = await prepare();
    const { userId } = await seedVaultedUser(appSchema, engineSchema);
    const tooEarly = new Date("2020-12-20T00:00:00.000Z");

    const mailer: MockMailer = {
      sendEmail: vi.fn().mockResolvedValue(undefined),
    };

    const result = await dispatchPreErasureNotice(sql, userId, TEST_SECRETS, mailer, {
      appSchema,
      engineSchema,
      now: tooEarly,
    });

    expect(result.action).toBe("not_due");
    expect(mailer.sendEmail).not.toHaveBeenCalled();

    const [vaultRow] = await sql`
      SELECT notification_sent_at
      FROM ${sql(engineSchema)}.pii_vault
      WHERE root_schema = ${appSchema}
        AND root_table = 'users'
        AND root_id = ${userId.toString()}
    `;
    expect(vaultRow?.notification_sent_at).toBeNull();
  });

  it("is idempotent after the notice has already been sent", async () => {
    const { appSchema, engineSchema } = await prepare();
    const { userId } = await seedVaultedUser(appSchema, engineSchema);
    const sendAt = new Date("2020-12-30T00:00:00.000Z");

    const mailer: MockMailer = {
      sendEmail: vi.fn().mockResolvedValue(undefined),
    };

    const first = await dispatchPreErasureNotice(sql, userId, TEST_SECRETS, mailer, {
      appSchema,
      engineSchema,
      now: sendAt,
    });
    const second = await dispatchPreErasureNotice(sql, userId, TEST_SECRETS, mailer, {
      appSchema,
      engineSchema,
      now: new Date("2020-12-30T01:00:00.000Z"),
    });

    expect(first.action).toBe("sent");
    expect(second.action).toBe("already_sent");
    expect(mailer.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("releases the notice lease after a mailer failure so the job can be retried", async () => {
    const { appSchema, engineSchema } = await prepare();
    const { userId } = await seedVaultedUser(appSchema, engineSchema);
    const sendAt = new Date("2020-12-30T00:00:00.000Z");

    const failingMailer: MockMailer = {
      sendEmail: vi.fn().mockRejectedValue(new Error("SMTP unavailable")),
    };

    await expect(
      dispatchPreErasureNotice(sql, userId, TEST_SECRETS, failingMailer, {
        appSchema,
        engineSchema,
        now: sendAt,
      })
    ).rejects.toThrow(/smtp unavailable/i);

    const [vaultAfterFailure] = await sql`
      SELECT notification_sent_at, notification_lock_id, notification_lock_expires_at
      FROM ${sql(engineSchema)}.pii_vault
      WHERE root_schema = ${appSchema}
        AND root_table = 'users'
        AND root_id = ${userId.toString()}
    `;
    expect(vaultAfterFailure?.notification_sent_at).toBeNull();
    expect(vaultAfterFailure?.notification_lock_id).toBeNull();
    expect(vaultAfterFailure?.notification_lock_expires_at).toBeNull();

    const goodMailer: MockMailer = {
      sendEmail: vi.fn().mockResolvedValue(undefined),
    };

    const retry = await dispatchPreErasureNotice(sql, userId, TEST_SECRETS, goodMailer, {
      appSchema,
      engineSchema,
      now: new Date("2020-12-30T00:30:00.000Z"),
    });

    expect(retry.action).toBe("sent");
    expect(goodMailer.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("uses configured notice columns instead of hardcoded email/full_name keys", async () => {
    const appSchema = uniqueSchema("notify_custom_app");
    const engineSchema = uniqueSchema("notify_custom_engine");
    schemasToDrop.push(appSchema, engineSchema);

    await dropSchemas(sql, appSchema, engineSchema);
    await sql`CREATE SCHEMA ${sql(appSchema)}`;
    await sql`
      CREATE TABLE ${sql(appSchema)}.members (
        id TEXT PRIMARY KEY,
        user_email TEXT NOT NULL,
        display_name TEXT NOT NULL
      )
    `;
    await sql`
      CREATE TABLE ${sql(appSchema)}.member_orders (
        id SERIAL PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES ${sql(appSchema)}.members(id)
      )
    `;
    await sql`
      INSERT INTO ${sql(appSchema)}.members (id, user_email, display_name)
      VALUES ('usr_opaque_1', 'custom@example.com', 'Custom Name')
    `;
    await runMigrations(sql, engineSchema);

    const vaultAt = new Date("2020-01-01T00:00:00.000Z");
    await vaultUser(sql, "usr_opaque_1", TEST_SECRETS, {
      appSchema,
      engineSchema,
      now: vaultAt,
      defaultRetentionYears: 1,
      noticeWindowHours: 48,
      rootTable: "members",
      rootIdColumn: "id",
      rootPiiColumns: {
        user_email: "HMAC",
        display_name: "STATIC_MASK",
      },
      satelliteTargets: [],
    });

    const mailer: MockMailer = {
      sendEmail: vi.fn().mockResolvedValue(undefined),
    };

    const result = await dispatchPreErasureNotice(sql, "usr_opaque_1", TEST_SECRETS, mailer, {
      appSchema,
      engineSchema,
      rootTable: "members",
      noticeEmailColumn: "user_email",
      noticeNameColumn: "display_name",
      rootPiiColumns: {
        user_email: "HMAC",
        display_name: "STATIC_MASK",
      },
      now: new Date("2020-12-30T00:00:00.000Z"),
    });

    expect(result.action).toBe("sent");
    expect(mailer.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "custom@example.com",
        body: expect.stringContaining("Dear Custom Name"),
      })
    );
  });
});
