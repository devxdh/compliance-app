import type { SqlExecutor, VaultRecord } from "./support.types";
import { DESTROYED_PII_SENTINEL } from "./support.types";

/**
 * Fetches a vault row by root identity tuple.
 *
 * Lookup uses `(root_schema, root_table, root_id, tenant_id)` to avoid cross-tenant collisions.
 *
 * @param sql - Postgres pool or transaction.
 * @param engineSchema - Worker engine schema.
 * @param appSchema - Source application schema.
 * @param userId - Source root identifier.
 * @param rootTable - Source root table name.
 * @param tenantId - Optional tenant discriminator.
 * @returns Matching vault row or `null` when not yet vaulted.
 */
export async function getVaultRecordByUserId(
  sql: SqlExecutor,
  engineSchema: string,
  appSchema: string,
  userId: string | number,
  rootTable: string = "users",
  tenantId?: string
): Promise<VaultRecord | null> {
  const rows = await sql<VaultRecord[]>`
    SELECT *
    FROM ${sql(engineSchema)}.pii_vault
    WHERE root_schema = ${appSchema}
      AND root_table = ${rootTable}
      AND root_id = ${userId.toString()}
      AND tenant_id = ${tenantId ?? ""}
  `;
  return rows[0] ?? null;
}

/**
 * Replaces vaulted ciphertext with a non-PII sentinel and marks the vault as shredded.
 *
 * @param sql - Postgres pool or transaction.
 * @param engineSchema - Worker engine schema.
 * @param userHash - Subject hash key in `pii_vault`.
 * @param shreddedAt - Timestamp to persist as `shredded_at`.
 */
export async function markVaultDestroyed(
  sql: SqlExecutor,
  engineSchema: string,
  userHash: string,
  shreddedAt: Date
): Promise<void> {
  await sql`
    UPDATE ${sql(engineSchema)}.pii_vault
    SET encrypted_pii = ${sql.json(DESTROYED_PII_SENTINEL)},
        shredded_at = ${shreddedAt},
        updated_at = ${shreddedAt}
    WHERE user_uuid_hash = ${userHash}
  `;
}
