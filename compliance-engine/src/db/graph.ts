/**
 * Dependency-graph discovery using PostgreSQL catalog metadata and recursive CTE traversal.
 */

import postgres from "postgres";
import { assertIdentifier, quoteQualifiedIdentifier } from "./identifiers";
import { fail } from "../errors";

export interface DependencyNode {
  table_schema: string;
  table_name: string;
  column_name: string;
  parent_table: string;
  depth: number;
}

export interface DependencyGraphOptions {
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 32;

function resolveMaxDepth(input?: number): number {
  if (input === undefined) {
    return DEFAULT_MAX_DEPTH;
  }

  if (!Number.isInteger(input) || input < 1) {
    fail({
      code: "DPDP_GRAPH_MAX_DEPTH_INVALID",
      title: "Invalid graph max depth",
      detail: "maxDepth must be an integer greater than 0.",
      category: "validation",
      retryable: false,
    });
  }

  return input;
}

/**
 * Discovers the transitive foreign-key dependency graph for a root table.
 *
 * The recursive CTE tracks visited OIDs to prevent cyclic loops and fails closed when the configured
 * depth limit is reached, avoiding partial graph mutation.
 *
 * @param sql - Postgres pool or active transaction.
 * @param schema - Root table schema.
 * @param rootTable - Root table name.
 * @param options - Optional traversal controls.
 * @returns Ordered dependency nodes containing table/column lineage metadata.
 * @throws {WorkerError} When root table is missing, depth is invalid, or depth limit is reached.
 */
export async function getDependencyGraph(
  sql: postgres.Sql | postgres.TransactionSql,
  schema: string,
  rootTable: string,
  options: DependencyGraphOptions = {}
): Promise<DependencyNode[]> {
  const safeSchema = assertIdentifier(schema, "schema name");
  const safeRootTable = assertIdentifier(rootTable, "table name");
  const maxDepth = resolveMaxDepth(options.maxDepth);
  const qualifiedRoot = quoteQualifiedIdentifier(safeSchema, safeRootTable);

  const [rootExists] = await sql<{ oid: string | null }[]>`
    SELECT to_regclass(${qualifiedRoot})::text AS oid
  `;

  if (!rootExists?.oid) {
    fail({
      code: "DPDP_GRAPH_ROOT_TABLE_MISSING",
      title: "Root table not found",
      detail: `Root table ${safeSchema}.${safeRootTable} does not exist.`,
      category: "validation",
      retryable: false,
      context: { schema: safeSchema, rootTable: safeRootTable },
    });
  }

  const result = await sql<
    Array<
      DependencyNode & {
        table_oid: number;
        reached_limit: boolean;
      }
    >
  >`
    WITH RECURSIVE dependency_tree AS (
      SELECT
        connamespace::regnamespace::text AS table_schema,
        conrelid::regclass::text AS table_name,
        a.attname AS column_name,
        confrelid::regclass::text AS parent_table,
        conrelid::oid AS table_oid,
        ARRAY[confrelid::oid, conrelid::oid] AS path,
        1 AS depth,
        FALSE AS reached_limit
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum = ANY(c.conkey)
      WHERE c.contype = 'f'
        AND c.confrelid = to_regclass(${qualifiedRoot})

      UNION ALL

      SELECT
        child.connamespace::regnamespace::text AS table_schema,
        child.conrelid::regclass::text AS table_name,
        a.attname AS column_name,
        child.confrelid::regclass::text AS parent_table,
        child.conrelid::oid AS table_oid,
        dt.path || child.conrelid::oid AS path,
        dt.depth + 1 AS depth,
        dt.depth + 1 >= ${maxDepth} AS reached_limit
      FROM pg_constraint child
      JOIN pg_attribute a
        ON a.attrelid = child.conrelid
       AND a.attnum = ANY(child.conkey)
      JOIN dependency_tree dt
        ON child.confrelid = dt.table_oid
      WHERE child.contype = 'f'
        AND dt.depth < ${maxDepth}
        AND NOT child.conrelid::oid = ANY(dt.path)
    )
    SELECT DISTINCT ON (table_name, column_name)
      table_schema,
      table_name,
      column_name,
      parent_table,
      depth,
      table_oid,
      reached_limit
    FROM dependency_tree
    ORDER BY table_name, column_name, depth ASC
  `;

  if (result.some((row) => row.depth >= maxDepth || row.reached_limit)) {
    fail({
      code: "DPDP_GRAPH_DEPTH_LIMIT_REACHED",
      title: "Dependency graph depth limit reached",
      detail: `Dependency graph for ${safeSchema}.${safeRootTable} reached the safety limit of ${maxDepth}. Increase maxDepth before running destructive operations.`,
      category: "integrity",
      retryable: false,
      fatal: true,
      context: { schema: safeSchema, rootTable: safeRootTable, maxDepth },
    });
  }

  return result.map(({ table_oid: _tableOid, reached_limit: _reachedLimit, ...node }) => node);
}
