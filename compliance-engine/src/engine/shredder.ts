import postgres from "postgres";
import { fail } from "../errors";
import { getLogger } from "../observability/logger";
import type { ShredUserOptions, ShredUserResult } from "./contracts";
import { DESTROYED_PII_SENTINEL, enqueueOutboxEvent, getVaultRecordByUserId, resolveSchemas } from "./support";

const logger = getLogger({ component: "shredder" });

function buildShredDryRunPlan(
  appSchema: string,
  engineSchema: string,
  rootTable: string,
  userId: number,
  userHash: string,
  retentionExpiry: Date
) {
  return {
    mode: "dry-run" as const,
    summary: `Would crypto-shred root row ${userId} (${userHash}) in ${appSchema}.${rootTable} after ${retentionExpiry.toISOString()}.`,
    checks: [
      `Read ${engineSchema}.pii_vault using (${appSchema}, ${rootTable}, ${userId}) as the lookup key.`,
      "Confirm that retention_expiry has passed.",
      "Require a completed notification unless explicitly disabled.",
      "Delete the DEK and replace the vault payload in one transaction.",
    ],
    cryptoSteps: [
      "Delete the encrypted DEK from the key ring.",
      "Leave only non-PII metadata and a destroyed sentinel in the vault row.",
    ],
    sqlSteps: [
      "BEGIN ISOLATION LEVEL REPEATABLE READ;",
      `SELECT * FROM ${engineSchema}.pii_vault WHERE root_schema = '${appSchema}' AND root_table = '${rootTable}' AND root_id = '${userId}' FOR UPDATE;`,
      `DELETE FROM ${engineSchema}.user_keys WHERE user_uuid_hash = '<user-hash>';`,
      `UPDATE ${engineSchema}.pii_vault SET encrypted_pii = '{"destroyed":true}', shredded_at = '<timestamp>';`,
      `INSERT INTO ${engineSchema}.outbox (...) VALUES (... 'SHRED_SUCCESS' ...);`,
      "COMMIT;",
    ],
  };
}

/**
 * Destroys the DEK and replaces vaulted ciphertext with a non-PII sentinel.
 *
 * The function enforces fail-closed shredding semantics:
 * 1. Retention must be fully elapsed.
 * 2. Pre-erasure notice must be sent unless explicitly bypassed.
 * 3. Key deletion and vault mutation happen atomically inside one repeatable-read transaction.
 *
 * @param sql - Postgres connection pool used for transactional shredding.
 * @param userId - Numeric subject identifier from the root table.
 * @param options - Shredding overrides such as schema/table, dry-run mode, and clock injection.
 * @returns Structured shred result describing whether shredding executed, was skipped, or was simulated.
 * @throws {WorkerError} When retention/notice preconditions fail or key/vault invariants are broken.
 */
export async function shredUser(
  sql: postgres.Sql,
  userId: number,
  options: ShredUserOptions = {}
): Promise<ShredUserResult> {
  if (!Number.isInteger(userId) || userId < 1) {
    fail({
      code: "DPDP_SHREDDER_USER_ID_INVALID",
      title: "Invalid root identifier",
      detail: "userId must be a positive integer.",
      category: "validation",
      retryable: false,
    });
  }

  const { appSchema, engineSchema } = resolveSchemas(options);
  const rootTable = options.rootTable ?? "users";
  const now = options.now ? new Date(options.now) : new Date();
  const requireNotification = options.requireNotification ?? true;

  const vault = await getVaultRecordByUserId(sql, engineSchema, appSchema, userId, rootTable);
  if (!vault) {
    fail({
      code: "DPDP_SHREDDER_VAULT_NOT_FOUND",
      title: "Vault record not found",
      detail: `Vault record not found for ${appSchema}.${rootTable}#${userId}.`,
      category: "validation",
      retryable: false,
    });
  }

  if (options.dryRun) {
    return {
      action: "dry_run",
      userHash: vault.user_uuid_hash,
      dryRun: true,
      shreddedAt: vault.shredded_at ? vault.shredded_at.toISOString() : null,
      outboxEventType: "SHRED_SUCCESS",
      plan: buildShredDryRunPlan(
        appSchema,
        engineSchema,
        rootTable,
        userId,
        vault.user_uuid_hash,
        new Date(vault.retention_expiry)
      ),
    };
  }

  return sql.begin("isolation level repeatable read", async (tx) => {
    const [lockedVault] = await tx`
      SELECT *
      FROM ${tx(engineSchema)}.pii_vault
      WHERE root_schema = ${appSchema}
        AND root_table = ${rootTable}
        AND root_id = ${userId.toString()}
      FOR UPDATE
    `;

    if (!lockedVault) {
      fail({
        code: "DPDP_SHREDDER_VAULT_LOST",
        title: "Vault record vanished during shredding",
        detail: `Vault record for ${appSchema}.${rootTable}#${userId} disappeared during shredding.`,
        category: "concurrency",
        retryable: true,
      });
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
      fail({
        code: "DPDP_SHREDDER_RETENTION_NOT_REACHED",
        title: "Retention window still active",
        detail: `Cannot shred root row ${userId} before retention expiry (${new Date(lockedVault.retention_expiry).toISOString()}).`,
        category: "validation",
        retryable: false,
      });
    }

    if (requireNotification && !lockedVault.notification_sent_at) {
      fail({
        code: "DPDP_SHREDDER_NOTICE_MISSING",
        title: "Pre-erasure notice missing",
        detail: `Cannot shred root row ${userId} before the pre-erasure notice has been sent.`,
        category: "validation",
        retryable: false,
      });
    }

    const deletedKeys = await tx`
      DELETE FROM ${tx(engineSchema)}.user_keys
      WHERE user_uuid_hash = ${lockedVault.user_uuid_hash}
      RETURNING user_uuid_hash
    `;

    if (deletedKeys.length === 0) {
      fail({
        code: "DPDP_SHREDDER_KEY_MISSING",
        title: "Key ring record missing",
        detail: `Cannot shred root row ${userId}: no active key exists for hash ${lockedVault.user_uuid_hash}.`,
        category: "integrity",
        retryable: false,
        fatal: true,
      });
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
        request_id: lockedVault.request_id,
        subject_opaque_id: lockedVault.root_id,
        tenant_id: lockedVault.tenant_id || null,
        trigger_source: lockedVault.trigger_source,
        legal_framework: lockedVault.legal_framework,
        actor_opaque_id: lockedVault.actor_opaque_id,
        applied_rule_name: lockedVault.applied_rule_name,
        event_timestamp: now.toISOString(),
        root_schema: appSchema,
        root_table: rootTable,
        root_id: userId.toString(),
        shredded_at: now.toISOString(),
      },
      lockedVault.request_id ? `shred:${lockedVault.request_id}` : `shred:${appSchema}:${rootTable}:${userId}`,
      now
    );

    logger.info(
      {
        userHash: lockedVault.user_uuid_hash,
        rootTable,
        rootId: userId,
      },
      "Root row crypto-shredded"
    );

    return {
      action: "shredded",
      userHash: lockedVault.user_uuid_hash,
      dryRun: false,
      shreddedAt: now.toISOString(),
      outboxEventType: "SHRED_SUCCESS",
    };
  });
}
