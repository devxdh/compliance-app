/**
 * MODULE 6: THE CRYPTO-SHREDDING ENGINE (STAGE 4)
 *
 * Expert view:
 * Shredding must be the last irreversible step. We therefore verify timing and
 * notice preconditions first, then delete the DEK and replace the ciphertext
 * with a non-PII sentinel in the same transaction.
 *
 * Layman view:
 * This is the final kill switch. Once the worker reaches this step, it destroys
 * the only key that can open the vault and overwrites the vault payload with a
 * harmless marker saying the data is gone.
 */

import postgres from "postgres";
import type { ShredUserOptions, ShredUserResult } from "./contracts";
import {
  DESTROYED_PII_SENTINEL,
  enqueueOutboxEvent,
  getVaultRecordByUserId,
  resolveSchemas,
} from "./support";

function buildShredDryRunPlan(appSchema: string, engineSchema: string, userId: number, userHash: string, retentionExpiry: Date) {
  return {
    mode: "dry-run" as const,
    summary: `Would crypto-shred user ${userId} (${userHash}) after verifying retention expiry ${retentionExpiry.toISOString()}.`,
    checks: [
      `Read ${engineSchema}.pii_vault using (${appSchema}, users, ${userId}) as the lookup key.`,
      "Confirm that retention_expiry has passed.",
      "Require a completed notification unless explicitly disabled.",
      "Delete the DEK and replace the vault payload in one transaction.",
    ],
    cryptoSteps: [
      "Delete the encrypted DEK from the key ring.",
      "Leave only non-PII metadata and a destroyed sentinel in the vault row.",
    ],
    sqlSteps: [
      `BEGIN ISOLATION LEVEL REPEATABLE READ;`,
      `SELECT * FROM ${engineSchema}.pii_vault WHERE root_schema = '${appSchema}' AND root_table = 'users' AND root_id = '${userId}' FOR UPDATE;`,
      `DELETE FROM ${engineSchema}.user_keys WHERE user_uuid_hash = '<user-hash>';`,
      `UPDATE ${engineSchema}.pii_vault SET encrypted_pii = '{"destroyed":true}', shredded_at = '<timestamp>';`,
      `INSERT INTO ${engineSchema}.outbox (...) VALUES (... 'SHRED_SUCCESS' ...);`,
      `COMMIT;`,
    ],
  };
}

/**
 * Layman Terms:
 * Triggers the "Kill Switch" for a user. It throws away their DEK, rendering the vault forever 
 * un-openable, and leaves a "destroyed" sticker on the vault so we know it's gone.
 * 
 * Technical Terms:
 * Stage 4 Crypto-Shredding. Locks the vault row, asserts retention expiry, deletes the DEK, 
 * updates the `pii_vault` with a `{ destroyed: true }` marker, and queues a `SHRED_SUCCESS` 
 * event to notify the Central API, all inside a `REPEATABLE READ` transaction.
 */
export async function shredUser(
  sql: postgres.Sql,
  userId: number,
  options: ShredUserOptions = {}
): Promise<ShredUserResult> {
  if (!Number.isInteger(userId) || userId < 1) {
    throw new Error("userId must be a positive integer.");
  }

  const { appSchema, engineSchema } = resolveSchemas(options);
  const now = options.now ? new Date(options.now) : new Date();
  const requireNotification = options.requireNotification ?? true;

  const vault = await getVaultRecordByUserId(sql, engineSchema, appSchema, userId);
  if (!vault) {
    throw new Error(`Vault record not found for ${appSchema}.users#${userId}.`);
  }

  if (options.dryRun) {
    return {
      action: "dry_run",
      userHash: vault.user_uuid_hash,
      dryRun: true,
      shreddedAt: vault.shredded_at ? vault.shredded_at.toISOString() : null,
      outboxEventType: "SHRED_SUCCESS",
      plan: buildShredDryRunPlan(appSchema, engineSchema, userId, vault.user_uuid_hash, new Date(vault.retention_expiry)),
    };
  }

  console.log(`--- EXECUTING CRYPTO-SHREDDING FOR USER #${userId} ---`);

  return sql.begin("isolation level repeatable read", async (tx) => {
    const [lockedVault] = await tx`
      SELECT *
      FROM ${tx(engineSchema)}.pii_vault
      WHERE root_schema = ${appSchema}
        AND root_table = 'users'
        AND root_id = ${userId.toString()}
      FOR UPDATE
    `;

    if (!lockedVault) {
      throw new Error(`Vault record vanished while shredding user ${userId}.`);
    }

    if (lockedVault.shredded_at) {
      return {
        action: "already_shredded",
        userHash: lockedVault.user_uuid_hash,
        dryRun: false,
        shreddedAt: new Date(lockedVault.shredded_at).toISOString(),
        outboxEventType: null,
      };
    }

    if (new Date(lockedVault.retention_expiry) > now) {
      throw new Error(
        `Cannot shred user ${userId} before retention expiry (${new Date(lockedVault.retention_expiry).toISOString()}).`
      );
    }

    if (requireNotification && !lockedVault.notification_sent_at) {
      throw new Error(`Cannot shred user ${userId} before the pre-erasure notice has been sent.`);
    }

    const deletedKeys = await tx`
      DELETE FROM ${tx(engineSchema)}.user_keys
      WHERE user_uuid_hash = ${lockedVault.user_uuid_hash}
      RETURNING user_uuid_hash
    `;

    if (deletedKeys.length === 0) {
      throw new Error(`Cannot shred user ${userId}: no active key exists for hash ${lockedVault.user_uuid_hash}.`);
    }

    await tx`
      UPDATE ${tx(engineSchema)}.pii_vault
      SET encrypted_pii = ${tx.json(DESTROYED_PII_SENTINEL)},
          shredded_at = ${now},
          updated_at = ${now}
      WHERE user_uuid_hash = ${lockedVault.user_uuid_hash}
    `;

    await enqueueOutboxEvent(
      tx,
      engineSchema,
      lockedVault.user_uuid_hash,
      "SHRED_SUCCESS",
      {
        rootSchema: appSchema,
        rootTable: "users",
        rootId: userId.toString(),
        shreddedAt: now.toISOString(),
      },
      `shred:${appSchema}:users:${userId}`,
      now
    );

    console.log(`[SUCCESS]: User #${userId} mathematically anonymized.`);

    return {
      action: "shredded",
      userHash: lockedVault.user_uuid_hash,
      dryRun: false,
      shreddedAt: now.toISOString(),
      outboxEventType: "SHRED_SUCCESS",
    };
  });
}
