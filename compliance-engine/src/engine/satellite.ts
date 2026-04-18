import type postgres from "postgres";
import { assertIdentifier } from "../db/identifiers";
import { fail } from "../errors";

interface SatelliteRowId {
  id: number;
}

function parseQualifiedTableName(tableName: string) {
  const [schema, table, ...rest] = tableName.split(".");
  if (!schema || !table || rest.length > 0) {
    fail({
      code: "DPDP_SATELLITE_TABLE_INVALID",
      title: "Invalid satellite table name",
      detail: `Invalid table name "${tableName}". Expected "schema.table".`,
      category: "validation",
      retryable: false,
      context: { tableName },
    });
  }

  return {
    schema: assertIdentifier(schema, "schema name"),
    table: assertIdentifier(table, "table name"),
  };
}

export async function redactSatelliteTable(
  tx: postgres.TransactionSql,
  tableName: string,
  lookupColumn: string,
  lookupValue: string,
  newHmacValue: string,
  batchSize: number = 1000
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    fail({
      code: "DPDP_SATELLITE_BATCH_SIZE_INVALID",
      title: "Invalid satellite batch size",
      detail: "batchSize must be an integer greater than 0.",
      category: "validation",
      retryable: false,
    });
  }

  const { schema, table } = parseQualifiedTableName(tableName);
  const safeLookupColumn = assertIdentifier(lookupColumn, "lookup column");
  let totalRedacted = 0;

  while (true) {
    const updatedRows = await tx<SatelliteRowId[]>`
      WITH batch AS (
        SELECT id
        FROM ${tx(schema)}.${tx(table)}
        WHERE ${tx(safeLookupColumn)} = ${lookupValue}
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${tx(schema)}.${tx(table)}
      SET ${tx(safeLookupColumn)} = ${newHmacValue}
      WHERE id IN (SELECT id FROM batch)
      RETURNING id
    `;

    if (updatedRows.length === 0) {
      break;
    }

    totalRedacted += updatedRows.length;
  }

  return totalRedacted;
}
