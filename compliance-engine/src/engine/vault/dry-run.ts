import postgres from "postgres";
import { getDependencyGraph } from "../../db/graph";
import type { VaultUserResult } from "../contracts";
import { getVaultRecordByUserId } from "../support";
import { buildVaultDryRunPlan, type RootMutationContext } from "./context";
import { resolveRetentionWindow } from "./retention";

/**
 * Prepared inputs shared across vault dry-run evaluation.
 */
export interface PreparedVaultDryRunContext {
  appSchema: string;
  engineSchema: string;
  rootContext: RootMutationContext;
  defaultRetentionYears: number;
  noticeWindowHours: number;
  graphMaxDepth: number;
  now: Date;
  tenantId?: string;
  userHash: string;
}

/**
 * Executes the vault dry-run path without mutating state.
 *
 * @param sql - Primary SQL handle used for time math and optional vault lookup.
 * @param sqlReplica - Optional replica handle for graph traversal.
 * @param subjectId - Root subject identifier.
 * @param context - Prepared dry-run context.
 * @returns Dry-run vault result with the computed execution plan.
 */
export async function runVaultDryRun(
  sql: postgres.Sql,
  sqlReplica: postgres.Sql | undefined,
  subjectId: string | number,
  context: PreparedVaultDryRunContext
): Promise<VaultUserResult> {
  const dependencies = await getDependencyGraph(
    sqlReplica ?? sql,
    context.appSchema,
    context.rootContext.rootTable,
    { maxDepth: context.graphMaxDepth }
  );
  const dependencyCount = dependencies.length;
  const retention = {
    retentionYears: context.defaultRetentionYears,
    appliedRuleName: "DEFAULT",
  };
  const { retentionExpiry, notificationDueAt } = await resolveRetentionWindow(
    sql,
    context.now,
    retention.retentionYears,
    context.noticeWindowHours
  );
  const existingVault =
    typeof sql === "function"
      ? await getVaultRecordByUserId(
        sql,
        context.engineSchema,
        context.appSchema,
        subjectId,
        context.rootContext.rootTable,
        context.tenantId
      )
      : null;

  return {
    action: "dry_run",
    userHash: context.userHash,
    dryRun: true,
    dependencyCount,
    retentionYears: dependencyCount === 0 ? null : retention.retentionYears,
    appliedRuleName: dependencyCount === 0 ? null : retention.appliedRuleName,
    retentionExpiry: dependencyCount === 0 ? null : retentionExpiry.toISOString(),
    notificationDueAt: dependencyCount === 0 ? null : notificationDueAt.toISOString(),
    pseudonym: existingVault?.pseudonym ?? null,
    outboxEventType: dependencyCount === 0 ? "USER_HARD_DELETED" : "USER_VAULTED",
    plan: buildVaultDryRunPlan(
      context.appSchema,
      context.engineSchema,
      subjectId,
      context.rootContext,
      context.userHash,
      dependencyCount,
      retentionExpiry,
      notificationDueAt,
      retention.appliedRuleName
    ),
  };
}
