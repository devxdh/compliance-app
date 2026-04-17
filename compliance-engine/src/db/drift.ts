import type postgres from "postgres";
import { assertIdentifier } from "./identifiers";
import { sha256Hex } from "../utils/digest";

interface SchemaColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
}

export type Sql = postgres.Sql | postgres.TransactionSql;

export async function detectSchemaDrift(sql: Sql, appSchema: string): Promise<string> {
  const safeAppSchema = assertIdentifier(appSchema, "application schema name");

  const columns = await sql<SchemaColumnRow[]>`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = ${safeAppSchema}
    ORDER BY table_name ASC, ordinal_position ASC, column_name ASC
  `;

  const signature = columns.map((column) => `${column.table_name}${column.column_name}${column.data_type}`).join("");
  return sha256Hex(signature);
}
