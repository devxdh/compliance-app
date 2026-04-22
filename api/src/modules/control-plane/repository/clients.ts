import type {
  ClientRow,
  CreateClientInput,
  RepositoryContext,
  RotateClientKeyInput,
} from "./types";

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
    INSERT INTO ${context.sql(context.schema)}.clients (
      name,
      worker_api_key_hash,
      display_name,
      current_key_id,
      is_active,
      rotated_at
    )
    VALUES (${name}, ${workerApiKeyHash}, ${name}, 'bootstrap', TRUE, NOW())
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

/**
 * Lists registered worker clients ordered by creation time.
 *
 * @param context - Repository SQL context.
 * @returns All persisted worker clients.
 */
export async function listClients(context: RepositoryContext): Promise<ClientRow[]> {
  return context.sql<ClientRow[]>`
    SELECT *
    FROM ${context.sql(context.schema)}.clients
    ORDER BY created_at ASC
  `;
}

/**
 * Creates a new worker client with its initial key metadata.
 *
 * @param context - Repository SQL context.
 * @param input - Client attributes and hashed token.
 * @returns Persisted client row.
 */
export async function createClient(
  context: RepositoryContext,
  input: CreateClientInput
): Promise<ClientRow> {
  const [row] = await context.sql<ClientRow[]>`
    INSERT INTO ${context.sql(context.schema)}.clients (
      name,
      display_name,
      worker_api_key_hash,
      current_key_id,
      is_active,
      rotated_at,
      created_at
    )
    VALUES (
      ${input.name},
      ${input.displayName ?? null},
      ${input.workerApiKeyHash},
      ${input.currentKeyId},
      TRUE,
      ${input.now},
      ${input.now}
    )
    RETURNING *
  `;
  return row!;
}

/**
 * Rotates the active worker token hash for an existing client.
 *
 * @param context - Repository SQL context.
 * @param input - Rotation metadata and new hashed token.
 * @returns Updated client row or `null`.
 */
export async function rotateClientKey(
  context: RepositoryContext,
  input: RotateClientKeyInput
): Promise<ClientRow | null> {
  const [row] = await context.sql<ClientRow[]>`
    UPDATE ${context.sql(context.schema)}.clients
    SET worker_api_key_hash = ${input.workerApiKeyHash},
        current_key_id = ${input.currentKeyId},
        rotated_at = ${input.now},
        is_active = TRUE
    WHERE name = ${input.name}
    RETURNING *
  `;
  return row ?? null;
}

/**
 * Enables or disables a worker client without deleting its audit lineage.
 *
 * @param context - Repository SQL context.
 * @param name - Stable worker client name.
 * @param active - Desired active state.
 * @returns Updated client row or `null`.
 */
export async function setClientActiveState(
  context: RepositoryContext,
  name: string,
  active: boolean
): Promise<ClientRow | null> {
  const [row] = await context.sql<ClientRow[]>`
    UPDATE ${context.sql(context.schema)}.clients
    SET is_active = ${active}
    WHERE name = ${name}
    RETURNING *
  `;
  return row ?? null;
}

/**
 * Marks a client as successfully authenticated by a worker request.
 *
 * @param context - Repository SQL context.
 * @param clientId - Worker client id.
 * @param now - Authentication timestamp.
 */
export async function touchClientAuthentication(
  context: RepositoryContext,
  clientId: string,
  now: Date
): Promise<void> {
  await context.sql`
    UPDATE ${context.sql(context.schema)}.clients
    SET last_authenticated_at = ${now}
    WHERE id = ${clientId}
  `;
}
