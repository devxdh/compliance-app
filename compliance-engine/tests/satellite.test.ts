import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { redactSatelliteTable } from "../src/engine/satellite";
import { createTestSql, dropSchemas, uniqueSchema } from "./helpers/db";

describe("Satellite Table Chunking", () => {
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
    const schema = uniqueSchema("satellite_app");
    schemasToDrop.push(schema);

    await dropSchemas(sql, schema);
    await sql`CREATE SCHEMA ${sql(schema)}`;
    await sql`
      CREATE TABLE ${sql(schema)}.orders (
        id SERIAL PRIMARY KEY,
        user_ref TEXT NOT NULL,
        amount NUMERIC NOT NULL
      )
    `;

    return { schema };
  }

  it("redacts matching satellite rows in batches until exhaustion", async () => {
    const { schema } = await prepare();

    for (let index = 0; index < 5; index += 1) {
      await sql`
        INSERT INTO ${sql(schema)}.orders (user_ref, amount)
        VALUES ('legacy-user', ${index + 1})
      `;
    }

    await sql`
      INSERT INTO ${sql(schema)}.orders (user_ref, amount)
      VALUES ('other-user', 99)
    `;

    const redacted = await sql.begin((tx) =>
      redactSatelliteTable(tx, `${schema}.orders`, "user_ref", "legacy-user", "hmac-user", 2)
    );

    expect(redacted).toBe(5);

    const rows = await sql`
      SELECT user_ref
      FROM ${sql(schema)}.orders
      ORDER BY id ASC
    `;

    expect(rows.map((row) => row.user_ref)).toEqual([
      "hmac-user",
      "hmac-user",
      "hmac-user",
      "hmac-user",
      "hmac-user",
      "other-user",
    ]);
  });

  it("returns zero when no rows match the lookup value", async () => {
    const { schema } = await prepare();

    const redacted = await sql.begin((tx) =>
      redactSatelliteTable(tx, `${schema}.orders`, "user_ref", "missing-user", "hmac-user", 100)
    );

    expect(redacted).toBe(0);
  });
});
