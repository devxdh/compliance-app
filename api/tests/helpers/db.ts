import postgres from "postgres";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

export function createTestSql(): postgres.Sql {
  return postgres(TEST_DATABASE_URL);
}

export function uniqueSchema(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export async function dropSchemas(sql: postgres.Sql, ...schemas: string[]) {
  for (const schema of schemas) {
    await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
  }
}
