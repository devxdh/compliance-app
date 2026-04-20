import type postgres from "postgres";
import type { WorkerConfig } from "../config/worker";
import { fail } from "../errors";

interface SchemaColumnRow {
  table_name: string;
  column_name: string;
}

function formatColumn(tableName: string, columnName: string): string {
  return `${tableName}.${columnName}`;
}

/**
 * Verifies that the live application schema satisfies every column/table reference in the
 * worker configuration before any task execution begins.
 *
 * This catches configuration drift such as missing root columns, satellite lookup columns,
 * masking-rule targets, and retention evidence tables at boot time instead of failing after
 * the worker has already leased work.
 *
 * @param sql - Postgres pool used for metadata inspection.
 * @param config - Parsed worker configuration.
 * @throws {WorkerError} When the application schema does not satisfy the worker configuration.
 */
export async function assertConfigSchemaCompatibility(
  sql: postgres.Sql,
  config: WorkerConfig
): Promise<void> {
  const rows = await sql<SchemaColumnRow[]>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = ${config.database.app_schema}
    ORDER BY table_name ASC, ordinal_position ASC
  `;

  const columnsByTable = new Map<string, Set<string>>();
  for (const row of rows) {
    const existing = columnsByTable.get(row.table_name) ?? new Set<string>();
    existing.add(row.column_name);
    columnsByTable.set(row.table_name, existing);
  }

  const violations: string[] = [];
  const rootTable = config.graph.root_table;
  const rootColumns = columnsByTable.get(rootTable);

  if (!rootColumns) {
    violations.push(`missing root table ${config.database.app_schema}.${rootTable}`);
  } else {
    const requiredRootColumns = new Set<string>([
      config.graph.root_id_column,
      ...Object.keys(config.graph.root_pii_columns),
      ...config.satellite_targets.map((target) => target.lookup_column),
    ]);

    if (config.graph.notice_email_column) {
      requiredRootColumns.add(config.graph.notice_email_column);
    }

    if (config.graph.notice_name_column) {
      requiredRootColumns.add(config.graph.notice_name_column);
    }

    for (const column of requiredRootColumns) {
      if (!rootColumns.has(column)) {
        violations.push(
          `missing root column ${formatColumn(`${config.database.app_schema}.${rootTable}`, column)}`
        );
      }
    }
  }

  for (const target of config.satellite_targets) {
    const targetColumns = columnsByTable.get(target.table);
    if (!targetColumns) {
      violations.push(`missing satellite table ${config.database.app_schema}.${target.table}`);
      continue;
    }

    if (!targetColumns.has(target.lookup_column)) {
      violations.push(
        `missing satellite lookup column ${formatColumn(
          `${config.database.app_schema}.${target.table}`,
          target.lookup_column
        )}`
      );
    }

    for (const column of Object.keys(target.masking_rules ?? {})) {
      if (!targetColumns.has(column)) {
        violations.push(
          `missing satellite masking column ${formatColumn(
            `${config.database.app_schema}.${target.table}`,
            column
          )}`
        );
      }
    }
  }

  for (const rule of config.compliance_policy.retention_rules) {
    for (const tableName of rule.if_has_data_in) {
      if (!columnsByTable.has(tableName)) {
        violations.push(`missing retention evidence table ${config.database.app_schema}.${tableName}`);
      }
    }
  }

  if (violations.length > 0) {
    fail({
      code: "DPDP_CONFIG_SCHEMA_MISMATCH",
      title: "Worker config does not match the application schema",
      detail: `Detected ${violations.length} schema compatibility violation(s): ${violations.join("; ")}`,
      category: "configuration",
      retryable: false,
      fatal: true,
      context: {
        appSchema: config.database.app_schema,
        violations,
      },
    });
  }
}
