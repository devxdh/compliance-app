import type postgres from "postgres";

export interface WorkerSecrets {
  kek: Uint8Array;
  hmacKey?: Uint8Array;
}

export interface WorkerSchemas {
  appSchema?: string;
  engineSchema?: string;
}

export interface WorkerTimingOptions {
  now?: Date;
  retentionYears?: number;
  noticeWindowHours?: number;
  graphMaxDepth?: number;
  dryRun?: boolean;
}

export interface DryRunPlan {
  mode: "dry-run";
  summary: string;
  checks: string[];
  cryptoSteps: string[];
  sqlSteps: string[];
}

export interface VaultUserOptions extends WorkerSchemas, WorkerTimingOptions {
  shadowMode?: boolean;
  sqlReplica?: postgres.Sql;
}

export interface DispatchNoticeOptions extends WorkerSchemas, WorkerTimingOptions {
  notificationLeaseSeconds?: number;
}

export interface ShredUserOptions extends WorkerSchemas, WorkerTimingOptions {
  requireNotification?: boolean;
}

export interface WorkerOperationResult {
  userHash: string | null;
  dryRun: boolean;
}

export interface VaultUserResult extends WorkerOperationResult {
  action:
    | "vaulted"
    | "already_vaulted"
    | "hard_deleted"
    | "already_hard_deleted"
    | "dry_run";
  dependencyCount: number;
  retentionExpiry: string | null;
  notificationDueAt: string | null;
  pseudonym: string | null;
  outboxEventType: string | null;
  plan?: DryRunPlan;
}

export interface DispatchNoticeResult extends WorkerOperationResult {
  action: "sent" | "already_sent" | "not_due" | "dry_run";
  retentionExpiry: string | null;
  notificationDueAt: string | null;
  notificationSentAt: string | null;
  outboxEventType: string | null;
  plan?: DryRunPlan;
}

export interface ShredUserResult extends WorkerOperationResult {
  action: "shredded" | "already_shredded" | "dry_run";
  shreddedAt: string | null;
  outboxEventType: string | null;
  plan?: DryRunPlan;
}
