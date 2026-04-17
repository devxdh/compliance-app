/**
 * MODULE 3.2: THE VAULTING ENGINE (STAGE 1)
 *
 * Expert view:
 * Vaulting is the worker's most critical mutation. It must be atomic, it must
 * be idempotent under retries, and it must never guess its way through a
 * partial dependency graph or invalid configuration.
 *
 * Layman view:
 * This is the moment where the worker takes a user's real details, locks them
 * in the vault, replaces the visible record with a fake stand-in, and writes a
 * "tell the main API later" note in the outbox. If any piece fails, everything
 * rolls back together.
 */

import postgres from "postgres";
import { encryptGCM } from "../crypto/aes";
import { generateDEK, wrapKey } from "../crypto/envelope";
import { getDependencyGraph } from "../db/graph";
import { quoteQualifiedIdentifier } from "../db/identifiers";
import type { VaultUserOptions, VaultUserResult, WorkerSecrets } from "./contracts";
import {
  assertWorkerSecrets,
  calculateRetentionWindow,
  createPseudonym,
  createUserHash,
  enqueueOutboxEvent,
  getVaultRecordByUserId,
  resolveGraphMaxDepth,
  resolveNoticeWindowHours,
  resolveRetentionYears,
  resolveSchemas,
} from "./support";

function buildVaultDryRunPlan(
  appSchema: string,
  engineSchema: string,
  userId: number,
  userHash: string,
  dependencyCount: number,
  retentionExpiry: Date,
  notificationDueAt: Date
) {
  const userTable = quoteQualifiedIdentifier(appSchema, "users");
  const vaultTable = quoteQualifiedIdentifier(engineSchema, "pii_vault");
  const keyTable = quoteQualifiedIdentifier(engineSchema, "user_keys");
  const outboxTable = quoteQualifiedIdentifier(engineSchema, "outbox");

  const action = dependencyCount === 0 ? "hard delete" : "vault";

  return {
    mode: "dry-run" as const,
    summary: `Would ${action} user ${userId} in ${appSchema}.users with worker hash ${userHash}.`,
    checks: [
      `Validate ${appSchema} and ${engineSchema} as trusted schema identifiers.`,
      `Traverse the foreign-key graph rooted at ${userTable}.`,
      `Lock the target row in ${userTable} before mutating it.`,
      "Write the outbox event atomically with the primary data mutation.",
    ],
    cryptoSteps:
      dependencyCount === 0
        ? ["No vaulting cryptography required because the root table has no dependent tables."]
        : [
          "Generate a one-time 32-byte DEK for the user.",
          "Encrypt the JSON PII payload with AES-256-GCM.",
          "Wrap the DEK with the worker KEK using envelope encryption.",
          "Generate an HMAC-backed pseudonym for the visible user record.",
        ],
    sqlSteps:
      dependencyCount === 0
        ? [
          `BEGIN ISOLATION LEVEL REPEATABLE READ;`,
          `SELECT id, email, full_name FROM ${userTable} WHERE id = ${userId} FOR UPDATE;`,
          `DELETE FROM ${userTable} WHERE id = ${userId};`,
          `INSERT INTO ${outboxTable} (...) VALUES (... 'USER_HARD_DELETED' ...);`,
          `COMMIT;`,
        ]
        : [
          `BEGIN ISOLATION LEVEL REPEATABLE READ;`,
          `SELECT id, email, full_name FROM ${userTable} WHERE id = ${userId} FOR UPDATE;`,
          `INSERT INTO ${vaultTable} (... retention_expiry='${retentionExpiry.toISOString()}', notification_due_at='${notificationDueAt.toISOString()}');`,
          `INSERT INTO ${keyTable} (...);`,
          `UPDATE ${userTable} SET email = '<pseudonym>', full_name = '<pseudonymized label>' WHERE id = ${userId};`,
          `INSERT INTO ${outboxTable} (...) VALUES (... 'USER_VAULTED' ...);`,
          `COMMIT;`,
        ],
  };
}

export class ShadowModeRollback extends Error {
  readonly result: VaultUserResult;

  constructor(result: VaultUserResult) {
    super("Shadow mode rollback.");
    this.name = "ShadowModeRollback";
    this.result = result;
  }
}

function finalizeVaultResult(result: VaultUserResult, shadowMode: boolean): VaultUserResult {
  if (shadowMode) {
    throw new ShadowModeRollback(result);
  }

  return result;
}

/**
 * Layman Terms:
 * Executes the "Hide the User" operation. It looks at the user, figures out if they have any 
 * connected records (like past orders). If they don't, it just deletes them instantly. If they do, 
 * it encrypts them, creates a fake ID, and updates the database all at once.
 * * Technical Terms:
 * Idempotently vaults or hard-deletes a user based on their relational footprint.
 * Returns a structured result detailing the exact state transition (e.g., `vaulted`, `hard_deleted`, 
 * `already_vaulted`) so orchestrators can handle the outcome symmetrically.
 */
export async function vaultUser(
  sql: postgres.Sql,
  userId: number,
  secrets: WorkerSecrets,
  options: VaultUserOptions = {}
): Promise<VaultUserResult> {
  if (!Number.isInteger(userId) || userId < 1) {
    throw new Error("userId must be a positive integer.");
  }

  const { appSchema, engineSchema } = resolveSchemas(options);
  const { kek, hmacKey } = assertWorkerSecrets(secrets);
  const retentionYears = resolveRetentionYears(options.retentionYears);
  const noticeWindowHours = resolveNoticeWindowHours(options.noticeWindowHours);
  const graphMaxDepth = resolveGraphMaxDepth(options.graphMaxDepth);
  const sqlReplica = options.sqlReplica;
  const now = options.now ? new Date(options.now) : new Date();
  const userHash = await createUserHash(userId, appSchema, hmacKey);

  // --- DRY RUN MODE (Executes Graph calculation outside transaction lock) ---
  if (options.dryRun) {
    const dependencies = await getDependencyGraph(sqlReplica ?? sql, appSchema, "users", { maxDepth: graphMaxDepth });
    const dependencyCount = dependencies.length;
    const { retentionExpiry, notificationDueAt } = calculateRetentionWindow(now, retentionYears, noticeWindowHours);
    const existingVault = await getVaultRecordByUserId(sql, engineSchema, appSchema, userId);

    return {
      action: "dry_run",
      userHash,
      dryRun: true,
      dependencyCount,
      retentionExpiry: dependencyCount === 0 ? null : retentionExpiry.toISOString(),
      notificationDueAt: dependencyCount === 0 ? null : notificationDueAt.toISOString(),
      pseudonym: existingVault?.pseudonym ?? null,
      outboxEventType: dependencyCount === 0 ? "USER_HARD_DELETED" : "USER_VAULTED",
      plan: buildVaultDryRunPlan(appSchema, engineSchema, userId, userHash, dependencyCount, retentionExpiry, notificationDueAt),
    };
  }

  console.log(`--- VAULTING USER #${userId} IN SCHEMA ${appSchema} ---`);

  // Type Issue Fixed: Removed the invalid generic <ArrayBufferLike> constraint
  let dek: Uint8Array = new Uint8Array(0);
  let encryptedPiiBuffer: Uint8Array = new Uint8Array(0);

  try {
    try {
      return await sql.begin("isolation level repeatable read", async (tx) => {
        // 1. LOCK THE ROOT ROW FIRST to establish the snapshot and prevent concurrent mutations
        const [lockedUser] = await tx<{ id: number; email: string; full_name: string }[]>`
          SELECT id, email, full_name
          FROM ${tx(appSchema)}.users
          WHERE id = ${userId}
          FOR UPDATE
        `;

        // 2. Validate Idempotency state within the snapshot
        const lockedVault = await getVaultRecordByUserId(tx, engineSchema, appSchema, userId);
        if (lockedVault) {
          return finalizeVaultResult(
            {
              action: "already_vaulted",
              userHash: lockedVault.user_uuid_hash,
              dryRun: false,
              dependencyCount: lockedVault.dependency_count,
              retentionExpiry: lockedVault.retention_expiry.toISOString(),
              notificationDueAt: lockedVault.notification_due_at.toISOString(),
              pseudonym: lockedVault.pseudonym,
              outboxEventType: null,
            },
            options.shadowMode ?? false
          );
        }

        if (!lockedUser) {
          const hardDeleteEvents = await tx<{ id: string }[]>`
            SELECT id
            FROM ${tx(engineSchema)}.outbox
            WHERE idempotency_key = ${`hard-delete:${appSchema}:users:${userId}`}
            LIMIT 1
          `;

          if (hardDeleteEvents.length > 0) {
            return finalizeVaultResult(
              {
                action: "already_hard_deleted",
                userHash,
                dryRun: false,
                dependencyCount: 0,
                retentionExpiry: null,
                notificationDueAt: null,
                pseudonym: null,
                outboxEventType: null,
              },
              options.shadowMode ?? false
            );
          }

          throw new Error(`User ${userId} disappeared before vaulting could begin.`);
        }

        // 3. EXECUTE GRAPH TRAVERSAL INSIDE THE SNAPSHOT to resolve TOCTOU race conditions
        const dependencies = await getDependencyGraph(tx, appSchema, "users", { maxDepth: graphMaxDepth });
        const dependencyCount = dependencies.length;
        const { retentionExpiry, notificationDueAt } = calculateRetentionWindow(now, retentionYears, noticeWindowHours);

        // 4. Branch Logic based on Deterministic Dependency Count
        if (dependencyCount === 0) {
          const deleted = await tx`
            DELETE FROM ${tx(appSchema)}.users
            WHERE id = ${userId}
            RETURNING id
          `;

          if (deleted.length === 0) {
            throw new Error(`User ${userId} could not be deleted from ${appSchema}.users.`);
          }

          await enqueueOutboxEvent(
            tx,
            engineSchema,
            userHash,
            "USER_HARD_DELETED",
            {
              rootSchema: appSchema,
              rootTable: "users",
              rootId: userId.toString(),
              deletedAt: now.toISOString(),
              dependencyCount: 0,
            },
            `hard-delete:${appSchema}:users:${userId}`,
            now
          );

          return finalizeVaultResult(
            {
              action: "hard_deleted",
              userHash,
              dryRun: false,
              dependencyCount: 0,
              retentionExpiry: null,
              notificationDueAt: null,
              pseudonym: null,
              outboxEventType: "USER_HARD_DELETED",
            },
            options.shadowMode ?? false
          );
        }

        // 5. Vaulting and Encryption Pipeline
        const salt = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString("hex");
        const pseudonym = await createPseudonym(userId, lockedUser.email, salt, hmacKey);

        dek = generateDEK();
        const wrappedDEK = await wrapKey(dek, kek);
        const piiToVault = JSON.stringify({
          email: lockedUser.email,
          full_name: lockedUser.full_name,
        });

        encryptedPiiBuffer = await encryptGCM(piiToVault, dek);
        const encryptedPiiPayload = {
          v: 1,
          data: Buffer.from(encryptedPiiBuffer).toString("base64"),
        };

        await tx`
          INSERT INTO ${tx(engineSchema)}.pii_vault (
            user_uuid_hash,
            root_schema,
            root_table,
            root_id,
            pseudonym,
            encrypted_pii,
            salt,
            dependency_count,
            retention_expiry,
            notification_due_at,
            created_at,
            updated_at
          )
          VALUES (
            ${userHash},
            ${appSchema},
            'users',
            ${userId.toString()},
            ${pseudonym},
            ${tx.json(encryptedPiiPayload)},
            ${salt},
            ${dependencyCount},
            ${retentionExpiry},
            ${notificationDueAt},
            ${now},
            ${now}
          )
        `;

        await tx`
          INSERT INTO ${tx(engineSchema)}.user_keys (user_uuid_hash, encrypted_dek, created_at)
          VALUES (${userHash}, ${wrappedDEK}, ${now})
        `;

        await tx`
          UPDATE ${tx(appSchema)}.users
          SET email = ${pseudonym},
              full_name = ${`PSEUDONYMIZED_${userHash.slice(0, 12)}`}
          WHERE id = ${userId}
        `;

        await enqueueOutboxEvent(
          tx,
          engineSchema,
          userHash,
          "USER_VAULTED",
          {
            rootSchema: appSchema,
            rootTable: "users",
            rootId: userId.toString(),
            pseudonym,
            dependencyCount,
            retentionExpiry: retentionExpiry.toISOString(),
            notificationDueAt: notificationDueAt.toISOString(),
            vaultedAt: now.toISOString(),
          },
          `vault:${appSchema}:users:${userId}`,
          now
        );

        console.log(`[SUCCESS]: User #${userId} vaulted and pseudonymized.`);

        return finalizeVaultResult(
          {
            action: "vaulted",
            userHash,
            dryRun: false,
            dependencyCount,
            retentionExpiry: retentionExpiry.toISOString(),
            notificationDueAt: notificationDueAt.toISOString(),
            pseudonym,
            outboxEventType: "USER_VAULTED",
          },
          options.shadowMode ?? false
        );
      });
    } catch (error) {
      if (error instanceof ShadowModeRollback) {
        return error.result;
      }

      throw error;
    }
  } finally {
    // Shred the unencrypted arrays from Node process memory immediately upon finish/error
    if (dek.length > 0) {
      dek.fill(0);
    }
    if (encryptedPiiBuffer.length > 0) {
      encryptedPiiBuffer.fill(0);
    }
  }
}
