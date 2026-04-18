import postgres from "postgres";
import type { MutationRule, RootPiiColumns, SatelliteTarget } from "../config/worker";
import { encryptGCM } from "../crypto/aes";
import { generateDEK, wrapKey } from "../crypto/envelope";
import { generateHMAC } from "../crypto/hmac";
import { getDependencyGraph } from "../db/graph";
import { assertIdentifier, quoteQualifiedIdentifier } from "../db/identifiers";
import { fail } from "../errors";
import type { VaultUserOptions, VaultUserResult, WorkerSecrets } from "./contracts";
import { redactSatelliteTable } from "./satellite";
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

const DEFAULT_SATELLITE_BATCH_SIZE = 1000;

interface RootMutationContext {
  rootTable: string;
  rootIdColumn: string;
  rootPiiColumns: RootPiiColumns;
  satelliteTargets: SatelliteTarget[];
}

interface SatelliteMutationResult {
  table: string;
  action: "redact" | "hard_delete";
  affectedRows: number;
}

function buildVaultDryRunPlan(
  appSchema: string,
  engineSchema: string,
  userId: number,
  rootContext: RootMutationContext,
  userHash: string,
  dependencyCount: number,
  retentionExpiry: Date,
  notificationDueAt: Date
) {
  const rootTable = quoteQualifiedIdentifier(appSchema, rootContext.rootTable);
  const vaultTable = quoteQualifiedIdentifier(engineSchema, "pii_vault");
  const keyTable = quoteQualifiedIdentifier(engineSchema, "user_keys");
  const outboxTable = quoteQualifiedIdentifier(engineSchema, "outbox");
  const mutationColumns = Object.keys(rootContext.rootPiiColumns).join(", ");

  const action = dependencyCount === 0 ? "hard delete" : "vault";
  const idempotencyPrefix = dependencyCount === 0 ? "hard-delete" : "vault";

  return {
    mode: "dry-run" as const,
    summary: `Would ${action} root row ${userId} in ${appSchema}.${rootContext.rootTable} with worker hash ${userHash}.`,
    checks: [
      `Validate ${appSchema} and ${engineSchema} as trusted schema identifiers.`,
      `Traverse the foreign-key graph rooted at ${rootTable}.`,
      `Lock the target row in ${rootTable} before mutating it.`,
      "Write the outbox event atomically with the primary data mutation.",
    ],
    cryptoSteps:
      dependencyCount === 0
        ? ["No vaulting cryptography required because the root table has no dependent tables."]
        : [
            "Generate a one-time 32-byte DEK for the root entity.",
            "Encrypt the configured root PII payload with AES-256-GCM.",
            "Wrap the DEK with the worker KEK using envelope encryption.",
            "Mutate configured root PII columns with rule-driven masking/HMAC/nullification.",
          ],
    sqlSteps:
      dependencyCount === 0
        ? [
            `BEGIN ISOLATION LEVEL REPEATABLE READ;`,
            `SELECT ... FROM ${rootTable} WHERE ${rootContext.rootIdColumn} = ${userId} FOR UPDATE;`,
            `DELETE FROM ${rootTable} WHERE ${rootContext.rootIdColumn} = ${userId};`,
            `INSERT INTO ${outboxTable} (...) VALUES (... '${idempotencyPrefix}:${appSchema}:${rootContext.rootTable}:${rootContext.rootIdColumn}:${userId}' ...);`,
            `COMMIT;`,
          ]
        : [
            `BEGIN ISOLATION LEVEL REPEATABLE READ;`,
            `SELECT ... FROM ${rootTable} WHERE ${rootContext.rootIdColumn} = ${userId} FOR UPDATE;`,
            `INSERT INTO ${vaultTable} (... retention_expiry='${retentionExpiry.toISOString()}', notification_due_at='${notificationDueAt.toISOString()}');`,
            `INSERT INTO ${keyTable} (...);`,
            `UPDATE ${rootTable} SET {${mutationColumns}} = <rule-driven values> WHERE ${rootContext.rootIdColumn} = ${userId};`,
            `INSERT INTO ${outboxTable} (...) VALUES (... '${idempotencyPrefix}:${appSchema}:${rootContext.rootTable}:${rootContext.rootIdColumn}:${userId}' ...);`,
            `COMMIT;`,
          ],
  };
}

function resolveRootContext(options: VaultUserOptions): RootMutationContext {
  if (!options.rootTable) {
    fail({
      code: "DPDP_VAULT_ROOT_TABLE_MISSING",
      title: "Missing root table configuration",
      detail: "rootTable is required.",
      category: "configuration",
      retryable: false,
      fatal: true,
    });
  }

  if (!options.rootIdColumn) {
    fail({
      code: "DPDP_VAULT_ROOT_ID_COLUMN_MISSING",
      title: "Missing root identifier configuration",
      detail: "rootIdColumn is required.",
      category: "configuration",
      retryable: false,
      fatal: true,
    });
  }

  if (!options.rootPiiColumns || Object.keys(options.rootPiiColumns).length === 0) {
    fail({
      code: "DPDP_VAULT_ROOT_PII_COLUMNS_MISSING",
      title: "Missing root PII column mapping",
      detail: "rootPiiColumns is required and must contain at least one mutation rule.",
      category: "configuration",
      retryable: false,
      fatal: true,
    });
  }

  const rootTable = assertIdentifier(options.rootTable, "graph root table");
  const rootIdColumn = assertIdentifier(options.rootIdColumn, "graph root id column");

  const rootPiiColumns: RootPiiColumns = {};
  for (const [column, mutation] of Object.entries(options.rootPiiColumns)) {
    rootPiiColumns[assertIdentifier(column, "graph root pii column")] = mutation;
  }

  const satelliteTargets = (options.satelliteTargets ?? []).map((target) => ({
    ...target,
    table: assertIdentifier(target.table, "satellite table name"),
    lookup_column: assertIdentifier(target.lookup_column, "satellite lookup column"),
  }));

  return {
    rootTable,
    rootIdColumn,
    rootPiiColumns,
    satelliteTargets,
  };
}

function normalizeRootRowValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return String(value);
}

async function computeMutationValue(
  mutation: MutationRule,
  originalValue: unknown,
  appSchema: string,
  rootTable: string,
  column: string,
  hmacKey: Uint8Array
): Promise<string | null> {
  if (mutation === "STATIC_MASK") {
    return "[REDACTED]";
  }

  if (mutation === "NULLIFY") {
    return null;
  }

  const normalizedValue = normalizeRootRowValue(originalValue);
  if (normalizedValue === null) {
    return null;
  }

  return generateHMAC(
    `${appSchema}:${rootTable}:${column}:${normalizedValue}`,
    Buffer.from(hmacKey).toString("base64")
  );
}

async function hardDeleteSatelliteRows(
  tx: postgres.TransactionSql,
  appSchema: string,
  tableName: string,
  lookupColumn: string,
  lookupValue: string,
  batchSize: number = DEFAULT_SATELLITE_BATCH_SIZE
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    fail({
      code: "DPDP_SATELLITE_BATCH_SIZE_INVALID",
      title: "Invalid satellite batch size",
      detail: "satellite batchSize must be an integer greater than 0.",
      category: "validation",
      retryable: false,
    });
  }

  let totalDeleted = 0;

  while (true) {
    const deletedRows = await tx<{ id: string | number }[]>`
      WITH batch AS (
        SELECT id
        FROM ${tx(appSchema)}.${tx(tableName)}
        WHERE ${tx(lookupColumn)} = ${lookupValue}
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM ${tx(appSchema)}.${tx(tableName)}
      WHERE id IN (SELECT id FROM batch)
      RETURNING id
    `;

    if (deletedRows.length === 0) {
      break;
    }

    totalDeleted += deletedRows.length;
  }

  return totalDeleted;
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
 * Vaults or hard-deletes a configured root entity under strict transactional guarantees.
 */
export async function vaultUser(
  sql: postgres.Sql,
  userId: number,
  secrets: WorkerSecrets,
  options: VaultUserOptions = {}
): Promise<VaultUserResult> {
  if (!Number.isInteger(userId) || userId < 1) {
    fail({
      code: "DPDP_VAULT_USER_ID_INVALID",
      title: "Invalid root identifier",
      detail: "userId must be a positive integer.",
      category: "validation",
      retryable: false,
    });
  }

  const { appSchema, engineSchema } = resolveSchemas(options);
  const rootContext = resolveRootContext(options);
  const { kek, hmacKey } = assertWorkerSecrets(secrets);
  const retentionYears = resolveRetentionYears(options.retentionYears);
  const noticeWindowHours = resolveNoticeWindowHours(options.noticeWindowHours);
  const graphMaxDepth = resolveGraphMaxDepth(options.graphMaxDepth);
  const sqlReplica = options.sqlReplica;
  const now = options.now ? new Date(options.now) : new Date();
  const userHash = await createUserHash(userId, appSchema, rootContext.rootTable, hmacKey);

  if (options.dryRun) {
    const dependencies = await getDependencyGraph(sqlReplica ?? sql, appSchema, rootContext.rootTable, {
      maxDepth: graphMaxDepth,
    });
    const dependencyCount = dependencies.length;
    const { retentionExpiry, notificationDueAt } = calculateRetentionWindow(now, retentionYears, noticeWindowHours);
    const existingVault = await getVaultRecordByUserId(sql, engineSchema, appSchema, userId, rootContext.rootTable);

    return {
      action: "dry_run",
      userHash,
      dryRun: true,
      dependencyCount,
      retentionExpiry: dependencyCount === 0 ? null : retentionExpiry.toISOString(),
      notificationDueAt: dependencyCount === 0 ? null : notificationDueAt.toISOString(),
      pseudonym: existingVault?.pseudonym ?? null,
      outboxEventType: dependencyCount === 0 ? "USER_HARD_DELETED" : "USER_VAULTED",
      plan: buildVaultDryRunPlan(
        appSchema,
        engineSchema,
        userId,
        rootContext,
        userHash,
        dependencyCount,
        retentionExpiry,
        notificationDueAt
      ),
    };
  }

  let dek: Uint8Array = new Uint8Array(0);
  let encryptedPiiBuffer: Uint8Array = new Uint8Array(0);

  try {
    try {
      return await sql.begin("isolation level repeatable read", async (tx) => {
        const columnsToSelect = [
          rootContext.rootIdColumn,
          ...new Set([
            ...Object.keys(rootContext.rootPiiColumns),
            ...rootContext.satelliteTargets.map((target) => target.lookup_column),
          ]),
        ];

        const [lockedRootRow] = await tx<Record<string, unknown>[]>`
          SELECT ${tx(columnsToSelect)}
          FROM ${tx(appSchema)}.${tx(rootContext.rootTable)}
          WHERE ${tx(rootContext.rootIdColumn)} = ${userId}
          FOR UPDATE
        `;

        const lockedVault = await getVaultRecordByUserId(tx, engineSchema, appSchema, userId, rootContext.rootTable);
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

        if (!lockedRootRow) {
          const hardDeleteEvents = await tx<{ id: string }[]>`
            SELECT id
            FROM ${tx(engineSchema)}.outbox
            WHERE idempotency_key = ${`hard-delete:${appSchema}:${rootContext.rootTable}:${rootContext.rootIdColumn}:${userId}`}
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

          fail({
            code: "DPDP_VAULT_ROOT_ROW_NOT_FOUND",
            title: "Root row not found",
            detail: `Root row ${appSchema}.${rootContext.rootTable}#${userId} disappeared before vaulting began.`,
            category: "validation",
            retryable: false,
          });
        }

        const dependencies = await getDependencyGraph(tx, appSchema, rootContext.rootTable, { maxDepth: graphMaxDepth });
        const dependencyCount = dependencies.length;
        const { retentionExpiry, notificationDueAt } = calculateRetentionWindow(now, retentionYears, noticeWindowHours);

        if (dependencyCount === 0) {
          const deleted = await tx`
            DELETE FROM ${tx(appSchema)}.${tx(rootContext.rootTable)}
            WHERE ${tx(rootContext.rootIdColumn)} = ${userId}
            RETURNING ${tx(rootContext.rootIdColumn)}
          `;

          if (deleted.length === 0) {
            fail({
              code: "DPDP_VAULT_ROOT_DELETE_FAILED",
              title: "Root row delete invariant failed",
              detail: `Root row ${appSchema}.${rootContext.rootTable}#${userId} could not be deleted.`,
              category: "concurrency",
              retryable: true,
            });
          }

          await enqueueOutboxEvent(
            tx,
            engineSchema,
            userHash,
            "USER_HARD_DELETED",
            {
              rootSchema: appSchema,
              rootTable: rootContext.rootTable,
              rootIdColumn: rootContext.rootIdColumn,
              rootId: userId.toString(),
              deletedAt: now.toISOString(),
              dependencyCount: 0,
            },
            `hard-delete:${appSchema}:${rootContext.rootTable}:${rootContext.rootIdColumn}:${userId}`,
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

        const rootPiiPayload: Record<string, unknown> = {};
        for (const column of Object.keys(rootContext.rootPiiColumns)) {
          rootPiiPayload[column] = lockedRootRow[column] ?? null;
        }

        const salt = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString("hex");
        const pseudonymSource =
          normalizeRootRowValue(rootPiiPayload[Object.keys(rootContext.rootPiiColumns)[0] ?? ""]) ??
          JSON.stringify(rootPiiPayload);
        const pseudonym = await createPseudonym(userId, pseudonymSource, salt, hmacKey);

        dek = generateDEK();
        const wrappedDEK = await wrapKey(dek, kek);
        encryptedPiiBuffer = await encryptGCM(JSON.stringify(rootPiiPayload), dek);
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
            ${rootContext.rootTable},
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

        for (const [column, mutation] of Object.entries(rootContext.rootPiiColumns)) {
          const mutatedValue = await computeMutationValue(
            mutation,
            lockedRootRow[column],
            appSchema,
            rootContext.rootTable,
            column,
            hmacKey
          );

          await tx`
            UPDATE ${tx(appSchema)}.${tx(rootContext.rootTable)}
            SET ${tx(column)} = ${mutatedValue}
            WHERE ${tx(rootContext.rootIdColumn)} = ${userId}
          `;
        }

        const satelliteMutations: SatelliteMutationResult[] = [];
        for (const target of rootContext.satelliteTargets) {
          const lookupValue = normalizeRootRowValue(lockedRootRow[target.lookup_column]);
          if (lookupValue === null) {
            satelliteMutations.push({
              table: `${appSchema}.${target.table}`,
              action: target.action,
              affectedRows: 0,
            });
            continue;
          }

          if (target.action === "redact") {
            const newHmacValue = await generateHMAC(
              `${appSchema}:${target.table}:${target.lookup_column}:${lookupValue}`,
              Buffer.from(hmacKey).toString("base64")
            );
            const affectedRows = await redactSatelliteTable(
              tx,
              `${appSchema}.${target.table}`,
              target.lookup_column,
              lookupValue,
              newHmacValue
            );
            satelliteMutations.push({
              table: `${appSchema}.${target.table}`,
              action: target.action,
              affectedRows,
            });
            continue;
          }

          const affectedRows = await hardDeleteSatelliteRows(
            tx,
            appSchema,
            target.table,
            target.lookup_column,
            lookupValue
          );
          satelliteMutations.push({
            table: `${appSchema}.${target.table}`,
            action: target.action,
            affectedRows,
          });
        }

        await enqueueOutboxEvent(
          tx,
          engineSchema,
          userHash,
          "USER_VAULTED",
          {
            rootSchema: appSchema,
            rootTable: rootContext.rootTable,
            rootIdColumn: rootContext.rootIdColumn,
            rootId: userId.toString(),
            pseudonym,
            dependencyCount,
            retentionExpiry: retentionExpiry.toISOString(),
            notificationDueAt: notificationDueAt.toISOString(),
            vaultedAt: now.toISOString(),
            satelliteMutations,
          },
          `vault:${appSchema}:${rootContext.rootTable}:${rootContext.rootIdColumn}:${userId}`,
          now
        );

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
    dek.fill(0);
    encryptedPiiBuffer.fill(0);
  }
}
