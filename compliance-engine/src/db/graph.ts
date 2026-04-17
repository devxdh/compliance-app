/**
 * MODULE 2: THE GRAPH ENGINE (THE CRAWLER)
 * Standard: Recursive Common Table Expression (CTE)
 *
 * Expert view:
 * The worker needs a safe picture of which tables can point back to the root
 * `users` table. We keep this traversal inside PostgreSQL because the catalog
 * already knows the foreign-key graph, and walking it in SQL is dramatically
 * safer and faster than N round-trips from application code.
 *
 * Layman view:
 * Think of the database as a family tree. This module asks Postgres to tell us
 * which tables are children, grandchildren, and deeper descendants of `users`.
 * If the tree looks incomplete or too deep for our safety limit, we stop.
 */

import postgres from "postgres";
import { assertIdentifier, quoteQualifiedIdentifier } from "./identifiers";

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
    throw new Error("maxDepth must be an integer greater than 0.");
  }

  return input;
}

/**
 * Layman Terms:
 * Triggers the magic map-making spell. If the database tells us the map is too big
 * (hits our max limit), we assume something is wrong (like a circular family tree)
 * and we crash, instead of deleting things blindly.
 * 
 * Technical Terms:
 * Returns the transitive foreign-key graph for a root table.
 * Safety note: We intentionally fail when the traversal touches the configured max depth.
 * That is conservative, but it avoids silently operating on a partial graph.
 */
export async function getDependencyGraph(
  sql: postgres.Sql,
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
    throw new Error(`Root table ${safeSchema}.${safeRootTable} does not exist.`);
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
    throw new Error(
      `Dependency graph for ${safeSchema}.${safeRootTable} reached the safety limit of ${maxDepth}. Increase maxDepth before running destructive operations.`
    );
  }

  return result.map(({ table_oid: _tableOid, reached_limit: _reachedLimit, ...node }) => node);
}
