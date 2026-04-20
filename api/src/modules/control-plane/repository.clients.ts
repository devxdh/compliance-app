import type { ClientRow, RepositoryContext } from "./repository.types";

/**
 * Upserts a worker client record and rotates its token hash atomically.
 *
 * @param context - Repository SQL context.
 * @param name - Stable worker client name.
 * @param workerApiKeyHash - SHA-256 digest of worker bearer token.
 * @returns Persisted client row.
 */
export async function ensureClient(
  context: RepositoryContext,
  name: string,
  workerApiKeyHash: string
): Promise<ClientRow> {
  const [row] = await context.sql<ClientRow[]>`
    INSERT INTO ${context.sql(context.schema)}.clients (name, worker_api_key_hash)
    VALUES (${name}, ${workerApiKeyHash})
    ON CONFLICT (name) DO UPDATE
      SET worker_api_key_hash = EXCLUDED.worker_api_key_hash
    RETURNING *
  `;
  return row!;
}

/**
 * Finds a registered worker client by name.
 *
 * @param context - Repository SQL context.
 * @param name - Worker client name.
 * @returns Matching client row or `null`.
 */
export async function getClientByName(
  context: RepositoryContext,
  name: string
): Promise<ClientRow | null> {
  const [row] = await context.sql<ClientRow[]>`
    SELECT *
    FROM ${context.sql(context.schema)}.clients
    WHERE name = ${name}
  `;
  return row ?? null;
}
