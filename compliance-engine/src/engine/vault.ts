import postgres from "postgres";
import type { MutationRule, RetentionRule, RootPiiColumns, SatelliteTarget } from "../config/worker";
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

export interface RetentionEvaluationConfig {
  default_retention_years: number;
  root_id_column: string;
  retention_rules: readonly RetentionRule[];
  app_schema: string;
}

export interface RetentionEvaluationResult {
  retentionYears: number;
  appliedRuleName: string;
}

function buildVaultDryRunPlan(
  appSchema: string,
  engineSchema: string,
  subjectId: string | number,
  rootContext: RootMutationContext,
  userHash: string,
  dependencyCount: number,
  retentionExpiry: Date,
  notificationDueAt: Date,
  appliedRuleName: string
) {
  const rootTable = quoteQualifiedIdentifier(appSchema, rootContext.rootTable);
  const vaultTable = quoteQualifiedIdentifier(engineSchema, "pii_vault");
  const keyTable = quoteQualifiedIdentifier(engineSchema, "user_keys");
  const outboxTable = quoteQualifiedIdentifier(engineSchema, "outbox");
  const mutationColumns = Object.keys(rootContext.rootPiiColumns).join(", ");

  const action = dependencyCount === 0 ? "hard delete" : "vault";

  return {
    mode: "dry-run" as const,
    summary: `Would ${action} root row ${subjectId} in ${appSchema}.${rootContext.rootTable} with worker hash ${userHash}.`,
    checks: [
      `Validate ${appSchema} and ${engineSchema} as trusted schema identifiers.`,
      `Traverse the foreign-key graph rooted at ${rootTable}.`,
      `Evaluate retention evidence and select rule ${appliedRuleName}.`,
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
            `SELECT ... FROM ${rootTable} WHERE ${rootContext.rootIdColumn} = '${String(subjectId)}' FOR UPDATE;`,
            `DELETE FROM ${rootTable} WHERE ${rootContext.rootIdColumn} = '${String(subjectId)}';`,
            `INSERT INTO ${outboxTable} (...) VALUES (...);`,
            `COMMIT;`,
          ]
        : [
            `BEGIN ISOLATION LEVEL REPEATABLE READ;`,
            `SELECT ... FROM ${rootTable} WHERE ${rootContext.rootIdColumn} = '${String(subjectId)}' FOR UPDATE;`,
            `INSERT INTO ${vaultTable} (... retention_expiry='${retentionExpiry.toISOString()}', notification_due_at='${notificationDueAt.toISOString()}', applied_rule_name='${appliedRuleName}');`,
            `INSERT INTO ${keyTable} (...);`,
            `UPDATE ${rootTable} SET {${mutationColumns}} = <rule-driven values> WHERE ${rootContext.rootIdColumn} = '${String(subjectId)}';`,
            `INSERT INTO ${outboxTable} (...) VALUES (...);`,
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
  tenantId?: string,
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
    const tenantFilter = tenantId ? tx` AND tenant_id = ${tenantId}` : tx``;
    const deletedRows = await tx<{ id: string | number }[]>`
      WITH batch AS (
        SELECT id
        FROM ${tx(appSchema)}.${tx(tableName)}
        WHERE ${tx(lookupColumn)} = ${lookupValue}
        ${tenantFilter}
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

async function mutateSatelliteTargets(
  tx: postgres.TransactionSql,
  appSchema: string,
  rootContext: RootMutationContext,
  lockedRootRow: Record<string, unknown>,
  hmacKey: Uint8Array,
  tenantId?: string
): Promise<SatelliteMutationResult[]> {
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
        newHmacValue,
        DEFAULT_SATELLITE_BATCH_SIZE,
        tenantId
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
      lookupValue,
      tenantId
    );
    satelliteMutations.push({
      table: `${appSchema}.${target.table}`,
      action: target.action,
      affectedRows,
    });
  }

  return satelliteMutations;
}

async function resolveRetentionWindow(
  tx: postgres.TransactionSql,
  now: Date,
  retentionYears: number,
  noticeWindowHours: number
): Promise<{ retentionExpiry: Date; notificationDueAt: Date }> {
  const [window] = await tx<{ retention_expiry: Date; notification_due_at: Date }[]>`
    SELECT
      ${now}::timestamptz + MAKE_INTERVAL(years := ${retentionYears}) AS retention_expiry,
      GREATEST(
        ${now}::timestamptz,
        ${now}::timestamptz + MAKE_INTERVAL(years := ${retentionYears}) - MAKE_INTERVAL(hours := ${noticeWindowHours})
      ) AS notification_due_at
  `;

  return {
    retentionExpiry: window!.retention_expiry,
    notificationDueAt: window!.notification_due_at,
  };
}

function buildVaultEventIdempotencyKey(options: VaultUserOptions, appSchema: string, rootTable: string, rootIdColumn: string, subjectId: string | number) {
  return options.requestId ? `vault:${options.requestId}` : `vault:${appSchema}:${rootTable}:${rootIdColumn}:${String(subjectId)}`;
}

function buildHardDeleteEventIdempotencyKey(
  options: VaultUserOptions,
  appSchema: string,
  rootTable: string,
  rootIdColumn: string,
  subjectId: string | number
) {
  return options.requestId
    ? `hard-delete:${options.requestId}`
    : `hard-delete:${appSchema}:${rootTable}:${rootIdColumn}:${String(subjectId)}`;
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

export async function evaluateRetention(
  tx: postgres.TransactionSql,
  subjectId: string | number,
  rules: RetentionEvaluationConfig,
  tenantId?: string
): Promise<RetentionEvaluationResult> {
  const rootIdColumn = assertIdentifier(rules.root_id_column, "graph root id column");
  let selectedYears = resolveRetentionYears(rules.default_retention_years);
  let selectedRuleName = "DEFAULT";

  for (const rule of rules.retention_rules) {
    for (const tableName of rule.if_has_data_in) {
      const safeTable = assertIdentifier(tableName, "retention rule evidence table");
      const tenantFilter = tenantId ? tx` AND tenant_id = ${tenantId}` : tx``;
      const [match] = await tx<{ exists: boolean }[]>`
        SELECT EXISTS(
          SELECT 1
          FROM ${tx(rules.app_schema)}.${tx(safeTable)}
          WHERE ${tx(rootIdColumn)} = ${subjectId}
          ${tenantFilter}
        ) AS exists
      `;

      if (match?.exists && rule.retention_years > selectedYears) {
        selectedYears = rule.retention_years;
        selectedRuleName = rule.rule_name;
      }
    }
  }

  return {
    retentionYears: selectedYears,
    appliedRuleName: selectedRuleName,
  };
}

/**
 * Vaults or hard-deletes a configured root entity under strict transactional guarantees.
 */
export async function vaultUser(
  sql: postgres.Sql,
  subjectId: string | number,
  secrets: WorkerSecrets,
  options: VaultUserOptions = {}
): Promise<VaultUserResult> {
  if ((typeof subjectId !== "string" && typeof subjectId !== "number") || String(subjectId).trim().length === 0) {
    fail({
      code: "DPDP_VAULT_USER_ID_INVALID",
      title: "Invalid root identifier",
      detail: "subjectId must be a non-empty string or number.",
      category: "validation",
      retryable: false,
    });
  }

  const { appSchema, engineSchema } = resolveSchemas(options);
  const rootContext = resolveRootContext(options);
  const { kek, hmacKey } = assertWorkerSecrets(secrets);
  const defaultRetentionYears = resolveRetentionYears(options.defaultRetentionYears);
  const noticeWindowHours = resolveNoticeWindowHours(options.noticeWindowHours);
  const graphMaxDepth = resolveGraphMaxDepth(options.graphMaxDepth);
  const sqlReplica = options.sqlReplica;
  const now = options.now ? new Date(options.now) : new Date();
  const tenantId = options.tenantId;
  const normalizedSubjectId = String(subjectId);
  const userHash = await createUserHash(subjectId, appSchema, rootContext.rootTable, hmacKey, tenantId);

  if (options.dryRun) {
    const dependencies = await getDependencyGraph(sqlReplica ?? sql, appSchema, rootContext.rootTable, {
      maxDepth: graphMaxDepth,
    });
    const dependencyCount = dependencies.length;
    const retention = {
      retentionYears: defaultRetentionYears,
      appliedRuleName: "DEFAULT",
    };
    const { retentionExpiry, notificationDueAt } = calculateRetentionWindow(now, retention.retentionYears, noticeWindowHours);
    const existingVault = await getVaultRecordByUserId(
      sql,
      engineSchema,
      appSchema,
      subjectId,
      rootContext.rootTable,
      tenantId
    );

    return {
      action: "dry_run",
      userHash,
      dryRun: true,
      dependencyCount,
      retentionYears: dependencyCount === 0 ? null : retention.retentionYears,
      appliedRuleName: dependencyCount === 0 ? null : retention.appliedRuleName,
      retentionExpiry: dependencyCount === 0 ? null : retentionExpiry.toISOString(),
      notificationDueAt: dependencyCount === 0 ? null : notificationDueAt.toISOString(),
      pseudonym: existingVault?.pseudonym ?? null,
      outboxEventType: dependencyCount === 0 ? "USER_HARD_DELETED" : "USER_VAULTED",
      plan: buildVaultDryRunPlan(
        appSchema,
        engineSchema,
        subjectId,
        rootContext,
        userHash,
        dependencyCount,
        retentionExpiry,
        notificationDueAt,
        retention.appliedRuleName
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
        const tenantFilter = tenantId ? tx` AND tenant_id = ${tenantId}` : tx``;

        const [lockedRootRow] = await tx<Record<string, unknown>[]>`
          SELECT ${tx(columnsToSelect)}
          FROM ${tx(appSchema)}.${tx(rootContext.rootTable)}
          WHERE ${tx(rootContext.rootIdColumn)} = ${subjectId}
          ${tenantFilter}
          FOR UPDATE
        `;

        const lockedVault = await getVaultRecordByUserId(
          tx,
          engineSchema,
          appSchema,
          subjectId,
          rootContext.rootTable,
          tenantId
        );
        if (lockedVault) {
          return finalizeVaultResult(
            {
              action: "already_vaulted",
              userHash: lockedVault.user_uuid_hash,
              dryRun: false,
              dependencyCount: lockedVault.dependency_count,
              retentionYears: lockedVault.applied_rule_name ? null : null,
              appliedRuleName: lockedVault.applied_rule_name,
              retentionExpiry: lockedVault.retention_expiry.toISOString(),
              notificationDueAt: lockedVault.notification_due_at.toISOString(),
              pseudonym: lockedVault.pseudonym,
              outboxEventType: null,
            },
            options.shadowMode ?? false
          );
        }

        if (!lockedRootRow) {
          const hardDeleteIdempotencyKey = buildHardDeleteEventIdempotencyKey(
            options,
            appSchema,
            rootContext.rootTable,
            rootContext.rootIdColumn,
            subjectId
          );
          const hardDeleteEvents = await tx<{ id: string }[]>`
            SELECT id
            FROM ${tx(engineSchema)}.outbox
            WHERE idempotency_key = ${hardDeleteIdempotencyKey}
            LIMIT 1
          `;

          if (hardDeleteEvents.length > 0) {
            return finalizeVaultResult(
              {
                action: "already_hard_deleted",
                userHash,
                dryRun: false,
                dependencyCount: 0,
                retentionYears: null,
                appliedRuleName: null,
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
            detail: `Root row ${appSchema}.${rootContext.rootTable}#${normalizedSubjectId} disappeared before vaulting began.`,
            category: "validation",
            retryable: false,
          });
        }

        const dependencies = await getDependencyGraph(tx, appSchema, rootContext.rootTable, { maxDepth: graphMaxDepth });
        const dependencyCount = dependencies.length;
        const retention = await evaluateRetention(
          tx,
          subjectId,
          {
            default_retention_years: defaultRetentionYears,
            root_id_column: rootContext.rootIdColumn,
            retention_rules: options.retentionRules ?? [],
            app_schema: appSchema,
          },
          tenantId
        );
        const { retentionExpiry, notificationDueAt } = await resolveRetentionWindow(
          tx,
          now,
          retention.retentionYears,
          noticeWindowHours
        );

        const satelliteMutations = await mutateSatelliteTargets(
          tx,
          appSchema,
          rootContext,
          lockedRootRow,
          hmacKey,
          tenantId
        );

        if (dependencyCount === 0) {
          const deleted = await tx`
            DELETE FROM ${tx(appSchema)}.${tx(rootContext.rootTable)}
            WHERE ${tx(rootContext.rootIdColumn)} = ${subjectId}
            ${tenantFilter}
            RETURNING ${tx(rootContext.rootIdColumn)}
          `;

          if (deleted.length === 0) {
            fail({
              code: "DPDP_VAULT_ROOT_DELETE_FAILED",
              title: "Root row delete invariant failed",
              detail: `Root row ${appSchema}.${rootContext.rootTable}#${normalizedSubjectId} could not be deleted.`,
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
              request_id: options.requestId ?? null,
              subject_opaque_id: options.subjectOpaqueId ?? normalizedSubjectId,
              tenant_id: tenantId ?? null,
              trigger_source: options.triggerSource ?? null,
              legal_framework: options.legalFramework ?? null,
              actor_opaque_id: options.actorOpaqueId ?? null,
              applied_rule_name: retention.appliedRuleName,
              event_timestamp: now.toISOString(),
              root_schema: appSchema,
              root_table: rootContext.rootTable,
              root_id_column: rootContext.rootIdColumn,
              root_id: normalizedSubjectId,
              deleted_at: now.toISOString(),
              dependency_count: 0,
              satellite_mutations: satelliteMutations,
            },
            buildHardDeleteEventIdempotencyKey(
              options,
              appSchema,
              rootContext.rootTable,
              rootContext.rootIdColumn,
              subjectId
            ),
            now
          );

          return finalizeVaultResult(
            {
              action: "hard_deleted",
              userHash,
              dryRun: false,
              dependencyCount: 0,
              retentionYears: retention.retentionYears,
              appliedRuleName: retention.appliedRuleName,
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
        const pseudonym = await createPseudonym(subjectId, pseudonymSource, salt, hmacKey);

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
            request_id,
            tenant_id,
            root_schema,
            root_table,
            root_id,
            pseudonym,
            encrypted_pii,
            salt,
            dependency_count,
            trigger_source,
            legal_framework,
            actor_opaque_id,
            applied_rule_name,
            retention_expiry,
            notification_due_at,
            created_at,
            updated_at
          )
          VALUES (
            ${userHash},
            ${options.requestId ?? null},
            ${tenantId ?? ""},
            ${appSchema},
            ${rootContext.rootTable},
            ${normalizedSubjectId},
            ${pseudonym},
            ${tx.json(encryptedPiiPayload)},
            ${salt},
            ${dependencyCount},
            ${options.triggerSource ?? null},
            ${options.legalFramework ?? null},
            ${options.actorOpaqueId ?? null},
            ${retention.appliedRuleName},
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

        const rootMutationValues: Record<string, string | null> = {};
        for (const [column, mutation] of Object.entries(rootContext.rootPiiColumns)) {
          rootMutationValues[column] = await computeMutationValue(
            mutation,
            lockedRootRow[column],
            appSchema,
            rootContext.rootTable,
            column,
            hmacKey
          );
        }

        await tx`
          UPDATE ${tx(appSchema)}.${tx(rootContext.rootTable)}
          SET ${tx(rootMutationValues)}
          WHERE ${tx(rootContext.rootIdColumn)} = ${subjectId}
          ${tenantFilter}
        `;

        await enqueueOutboxEvent(
          tx,
          engineSchema,
          userHash,
          "USER_VAULTED",
          {
            request_id: options.requestId ?? null,
            subject_opaque_id: options.subjectOpaqueId ?? normalizedSubjectId,
            tenant_id: tenantId ?? null,
            trigger_source: options.triggerSource ?? null,
            legal_framework: options.legalFramework ?? null,
            actor_opaque_id: options.actorOpaqueId ?? null,
            applied_rule_name: retention.appliedRuleName,
            event_timestamp: now.toISOString(),
            root_schema: appSchema,
            root_table: rootContext.rootTable,
            root_id_column: rootContext.rootIdColumn,
            root_id: normalizedSubjectId,
            pseudonym,
            dependency_count: dependencyCount,
            retention_years: retention.retentionYears,
            retention_expiry: retentionExpiry.toISOString(),
            notification_due_at: notificationDueAt.toISOString(),
            vaulted_at: now.toISOString(),
            satellite_mutations: satelliteMutations,
          },
          buildVaultEventIdempotencyKey(
            options,
            appSchema,
            rootContext.rootTable,
            rootContext.rootIdColumn,
            subjectId
          ),
          now
        );

        return finalizeVaultResult(
          {
            action: "vaulted",
            userHash,
            dryRun: false,
            dependencyCount,
            retentionYears: retention.retentionYears,
            appliedRuleName: retention.appliedRuleName,
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
