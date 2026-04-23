import postgres from "postgres";
import { fail } from "../../errors";
import type { VaultUserOptions, VaultUserResult, WorkerSecrets } from "../contracts";
import {
  assertWorkerSecrets,
  createUserHash,
  resolveGraphMaxDepth,
  resolveNoticeWindowHours,
  resolveRetentionYears,
  resolveSchemas,
} from "../support";
import { resolveRootContext } from "./context";
import { runVaultDryRun } from "./dry-run";
import { runVaultMutation } from "./execution";
import {
  evaluateRetention,
  type RetentionEvaluationConfig,
  type RetentionEvaluationResult,
} from "./retention";
import { ShadowModeRollback } from "./shadow";

export {
  evaluateRetention,
  ShadowModeRollback,
  type RetentionEvaluationConfig,
  type RetentionEvaluationResult,
};

/**
 * Vaults or hard-deletes a configured root entity under repeatable-read guarantees.
 *
 * @param sql - Primary Postgres pool used for transactional writes.
 * @param subjectId - Root identifier for the subject.
 * @param secrets - Worker KEK/HMAC key material.
 * @param options - Vault execution options, including graph, retention, tenancy, and dry-run flags.
 * @returns Vault execution result with lifecycle timestamps and outbox classification.
 * @throws {WorkerError} When validation, integrity, concurrency, or crypto preconditions fail.
 */
export async function vaultUser(
  sql: postgres.Sql,
  subjectId: string | number,
  secrets: WorkerSecrets,
  options: VaultUserOptions = {}
): Promise<VaultUserResult> {
  if (
    (typeof subjectId !== "string" && typeof subjectId !== "number") ||
    String(subjectId).trim().length === 0
  ) {
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
  const now = options.now ? new Date(options.now) : new Date();
  const tenantId = options.tenantId;
  const normalizedSubjectId = String(subjectId);
  const userHash = await createUserHash(
    subjectId,
    appSchema,
    rootContext.rootTable,
    hmacKey,
    tenantId
  );

  if (options.dryRun) {
    return runVaultDryRun(sql, options.sqlReplica, subjectId, {
      appSchema,
      engineSchema,
      rootContext,
      defaultRetentionYears,
      noticeWindowHours,
      graphMaxDepth,
      now,
      tenantId,
      userHash,
    });
  }

  return runVaultMutation(sql, subjectId, {
    appSchema,
    engineSchema,
    rootContext,
    defaultRetentionYears,
    noticeWindowHours,
    graphMaxDepth,
    now,
    tenantId,
    normalizedSubjectId,
    userHash,
    kek,
    hmacKey,
    options,
  });
}
