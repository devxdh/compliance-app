import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { evaluateRetention } from "../src/engine/vault";
import { createTestSql, dropSchemas, uniqueSchema } from "./helpers/db";

describe("Retention Evaluation Engine", () => {
  let sql: postgres.Sql;
  const schemasToDrop: string[] = [];

  beforeAll(() => {
    sql = createTestSql();
  });

  afterAll(async () => {
    await dropSchemas(sql, ...schemasToDrop);
    await sql.end();
  });

  it("selects the longest retention rule when evidence exists in multiple tables", async () => {
    const appSchema = uniqueSchema("retention_app");
    schemasToDrop.push(appSchema);

    await dropSchemas(sql, appSchema);
    await sql`CREATE SCHEMA ${sql(appSchema)}`;
    await sql`CREATE TABLE ${sql(appSchema)}.transactions (id SERIAL PRIMARY KEY, idempotent_user_id TEXT NOT NULL)`;
    await sql`CREATE TABLE ${sql(appSchema)}.kyc_documents (id SERIAL PRIMARY KEY, idempotent_user_id TEXT NOT NULL)`;
    await sql`
      INSERT INTO ${sql(appSchema)}.transactions (idempotent_user_id)
      VALUES ('usr_multi')
    `;
    await sql`
      INSERT INTO ${sql(appSchema)}.kyc_documents (idempotent_user_id)
      VALUES ('usr_multi')
    `;

    const result = await sql.begin(async (tx) =>
      evaluateRetention(
        tx,
        "usr_multi",
        {
          default_retention_years: 0,
          root_id_column: "idempotent_user_id",
          retention_rules: [
            {
              rule_name: "RBI_KYC",
              if_has_data_in: ["kyc_documents"],
              retention_years: 5,
            },
            {
              rule_name: "PMLA_FINANCIAL",
              if_has_data_in: ["transactions"],
              retention_years: 10,
            },
          ],
          app_schema: appSchema,
        }
      )
    );

    expect(result).toEqual({
      retentionYears: 10,
      appliedRuleName: "PMLA_FINANCIAL",
    });
  });

  it("falls back to the default retention window when no evidence rule matches", async () => {
    const appSchema = uniqueSchema("retention_default");
    schemasToDrop.push(appSchema);

    await dropSchemas(sql, appSchema);
    await sql`CREATE SCHEMA ${sql(appSchema)}`;
    await sql`CREATE TABLE ${sql(appSchema)}.transactions (id SERIAL PRIMARY KEY, subject_id TEXT NOT NULL)`;

    const result = await sql.begin(async (tx) =>
      evaluateRetention(
        tx,
        "usr_none",
        {
          default_retention_years: 1,
          root_id_column: "subject_id",
          retention_rules: [
            {
              rule_name: "PMLA_FINANCIAL",
              if_has_data_in: ["transactions"],
              retention_years: 10,
            },
          ],
          app_schema: appSchema,
        }
      )
    );

    expect(result).toEqual({
      retentionYears: 1,
      appliedRuleName: "DEFAULT",
    });
  });
});
