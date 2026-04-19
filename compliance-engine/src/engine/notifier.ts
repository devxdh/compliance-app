import postgres from "postgres";
import { decryptGCMBytes } from "../crypto/aes";
import { unwrapKey } from "../crypto/envelope";
import { assertIdentifier } from "../db/identifiers";
import { fail } from "../errors";
import { getLogger, logError } from "../observability/logger";
import type { DispatchNoticeOptions, DispatchNoticeResult, WorkerSecrets } from "./contracts";
import { assertWorkerSecrets, enqueueOutboxEvent, getVaultRecordByUserId, resolveSchemas } from "./support";
import type { VaultRecord } from "./support";

const logger = getLogger({ component: "notifier" });
const textDecoder = new TextDecoder();

export interface MailMessage {
  to: string;
  subject: string;
  body: string;
  idempotencyKey: string;
}

/**
 * Mail transport abstraction used by the worker.
 *
 * Implementations must honor `idempotencyKey` to prevent duplicate notices during retries.
 */
export interface MockMailer {
  sendEmail(message: MailMessage): Promise<void>;
}

interface NoticeReservation {
  action: "send" | "already_sent" | "not_due";
  vault: VaultRecord;
  encryptedDek?: Uint8Array;
  lockId?: string;
}

function resolveNotificationLeaseSeconds(value?: number): number {
  if (value === undefined) {
    return 120;
  }

  if (!Number.isInteger(value) || value < 1) {
    fail({
      code: "DPDP_NOTIFICATION_LEASE_INVALID",
      title: "Invalid notification lease",
      detail: "notificationLeaseSeconds must be an integer greater than 0.",
      category: "validation",
      retryable: false,
    });
  }

  return value;
}

function buildNotificationIdempotencyKey(vault: VaultRecord): string {
  return vault.request_id
    ? `notice:${vault.request_id}:${vault.notification_due_at.toISOString()}`
    : `notice:${vault.root_schema}:${vault.root_table}:${vault.root_id}:${vault.notification_due_at.toISOString()}`;
}

function resolveNoticeColumns(options: DispatchNoticeOptions): { emailColumn: string; nameColumn?: string } {
  if (options.noticeEmailColumn) {
    return {
      emailColumn: assertIdentifier(options.noticeEmailColumn, "graph notice email column"),
      nameColumn: options.noticeNameColumn
        ? assertIdentifier(options.noticeNameColumn, "graph notice name column")
        : undefined,
    };
  }

  const configuredColumns = new Set(Object.keys(options.rootPiiColumns ?? {}));
  if (configuredColumns.size === 0) {
    return {
      emailColumn: "email",
      nameColumn: "full_name",
    };
  }

  if (configuredColumns.has("email")) {
    return {
      emailColumn: "email",
      nameColumn: configuredColumns.has("full_name") ? "full_name" : undefined,
    };
  }

  fail({
    code: "DPDP_NOTIFICATION_EMAIL_COLUMN_MISSING",
    title: "Missing notice email column mapping",
    detail:
      "noticeEmailColumn is required when root_pii_columns does not contain 'email'. Configure graph.notice_email_column in compliance.worker.yml.",
    category: "configuration",
    retryable: false,
    fatal: true,
  });
}

function buildNoticeDryRunPlan(
  appSchema: string,
  engineSchema: string,
  rootTable: string,
  subjectId: string | number,
  userHash: string,
  notificationDueAt: Date,
  retentionExpiry: Date
) {
  return {
    mode: "dry-run" as const,
    summary: `Would attempt the pre-erasure notice for root row ${subjectId} (${userHash}).`,
    checks: [
      `Read ${engineSchema}.pii_vault using (${appSchema}, ${rootTable}, ${subjectId}) as the lookup key.`,
      `Verify that now is between notification_due_at (${notificationDueAt.toISOString()}) and retention_expiry (${retentionExpiry.toISOString()}).`,
      "Acquire a short notification lease before decrypting or sending mail.",
      "Use a deterministic mail idempotency key so retries do not duplicate sends.",
      "Write the outbox event only after the mailer succeeds.",
    ],
    cryptoSteps: [
      "Unwrap the stored DEK with the worker KEK.",
      "Decrypt the vaulted JSON payload in memory only.",
      "Null and overwrite temporary buffers after the email path completes.",
    ],
    sqlSteps: [
      `SELECT * FROM ${engineSchema}.pii_vault WHERE root_schema = '${appSchema}' AND root_table = '${rootTable}' AND root_id = '${subjectId}' FOR UPDATE;`,
      `UPDATE ${engineSchema}.pii_vault SET notification_lock_id = '<uuid>', notification_lock_expires_at = '<lease-expiry>';`,
      `SELECT * FROM ${engineSchema}.user_keys WHERE user_uuid_hash = '<user-hash>';`,
      `UPDATE ${engineSchema}.pii_vault SET notification_sent_at = '<timestamp>', notification_lock_id = NULL, notification_lock_expires_at = NULL;`,
      `INSERT INTO ${engineSchema}.outbox (...) VALUES (... 'NOTIFICATION_SENT' ...);`,
    ],
  };
}

async function reserveNotice(
  sql: postgres.Sql,
  engineSchema: string,
  appSchema: string,
  rootTable: string,
  subjectId: string | number,
  now: Date,
  leaseSeconds: number
): Promise<NoticeReservation> {
  const normalizedSubjectId = String(subjectId);

  return sql.begin("isolation level repeatable read", async (tx) => {
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");

    const [vault] = await tx<VaultRecord[]>`
      SELECT *
      FROM ${tx(engineSchema)}.pii_vault
      WHERE root_schema = ${appSchema}
        AND root_table = ${rootTable}
        AND root_id = ${normalizedSubjectId}
      FOR UPDATE
    `;

    if (!vault) {
      fail({
        code: "DPDP_VAULT_NOT_FOUND",
        title: "Vault record not found",
        detail: `Vault record not found for ${appSchema}.${rootTable}#${normalizedSubjectId}.`,
        category: "validation",
        retryable: false,
      });
    }

    if (vault.shredded_at) {
      fail({
        code: "DPDP_NOTIFICATION_SHREDDED",
        title: "Notification cannot be sent after shredding",
        detail: `Cannot dispatch notice for root row ${normalizedSubjectId}: the vault has already been shredded.`,
        category: "validation",
        retryable: false,
      });
    }

    if (vault.notification_sent_at) {
      return { action: "already_sent", vault };
    }

    if (now < new Date(vault.notification_due_at)) {
      return { action: "not_due", vault };
    }

    if (now >= new Date(vault.retention_expiry)) {
      fail({
        code: "DPDP_NOTIFICATION_WINDOW_MISSED",
        title: "Notification window has closed",
        detail: `Cannot dispatch notice for root row ${normalizedSubjectId}: the retention deadline has already expired.`,
        category: "validation",
        retryable: false,
      });
    }

    if (vault.notification_lock_expires_at && new Date(vault.notification_lock_expires_at) > now) {
      fail({
        code: "DPDP_NOTIFICATION_ALREADY_LEASED",
        title: "Notification is already leased",
        detail: `Notification for root row ${normalizedSubjectId} is already leased by another worker.`,
        category: "concurrency",
        retryable: true,
      });
    }

    const lockId = globalThis.crypto.randomUUID();
    const lockExpiry = new Date(now.getTime() + leaseSeconds * 1000);

    await tx`
      UPDATE ${tx(engineSchema)}.pii_vault
      SET notification_lock_id = ${lockId},
          notification_lock_expires_at = ${lockExpiry},
          updated_at = ${now}
      WHERE user_uuid_hash = ${vault.user_uuid_hash}
    `;

    const [keyRow] = await tx<{ encrypted_dek: Uint8Array }[]>`
      SELECT encrypted_dek
      FROM ${tx(engineSchema)}.user_keys
      WHERE user_uuid_hash = ${vault.user_uuid_hash}
      FOR UPDATE
    `;

    if (!keyRow) {
      fail({
        code: "DPDP_KEY_RING_NOT_FOUND",
        title: "Key ring record not found",
        detail: `Key ring record not found for user hash ${vault.user_uuid_hash}.`,
        category: "integrity",
        retryable: false,
        fatal: true,
      });
    }

    return {
      action: "send",
      vault,
      encryptedDek: new Uint8Array(keyRow.encrypted_dek),
      lockId,
    };
  });
}

async function clearNoticeLease(
  sql: postgres.Sql,
  engineSchema: string,
  userHash: string,
  lockId: string,
  now: Date
) {
  await sql`
    UPDATE ${sql(engineSchema)}.pii_vault
    SET notification_lock_id = NULL,
        notification_lock_expires_at = NULL,
        updated_at = ${now}
    WHERE user_uuid_hash = ${userHash}
      AND notification_lock_id = ${lockId}
  `;
}

/**
 * Dispatches the pre-erasure notice for a vaulted subject.
 *
 * Execution model:
 * - Reserves a short-lived notification lease on the vault row.
 * - Decrypts vaulted PII in memory only.
 * - Sends one deterministic idempotent email.
 * - Emits `NOTIFICATION_SENT` to outbox only after successful mail delivery.
 *
 * @param sql - Postgres pool used for lease + state transitions.
 * @param subjectId - Root identifier.
 * @param secrets - Worker cryptographic keys used for DEK unwrap/decrypt.
 * @param mailer - Injected mail transport.
 * @param options - Schema and runtime overrides (lease, dry-run, clock).
 * @returns Notice dispatch result with lifecycle timestamps and outbox classification.
 * @throws {WorkerError} When vault state is invalid, lease is lost, or crypto checks fail.
 */
export async function dispatchPreErasureNotice(
  sql: postgres.Sql,
  subjectId: string | number,
  secrets: WorkerSecrets,
  mailer: MockMailer,
  options: DispatchNoticeOptions = {}
): Promise<DispatchNoticeResult> {
  if ((typeof subjectId !== "string" && typeof subjectId !== "number") || String(subjectId).trim().length === 0) {
    fail({
      code: "DPDP_NOTIFICATION_USER_ID_INVALID",
      title: "Invalid root identifier",
      detail: "subjectId must be a non-empty string or number.",
      category: "validation",
      retryable: false,
    });
  }

  const normalizedSubjectId = String(subjectId);
  const { appSchema, engineSchema } = resolveSchemas(options);
  const rootTable = options.rootTable ?? "users";
  const { kek } = assertWorkerSecrets(secrets);
  const now = options.now ? new Date(options.now) : new Date();
  const leaseSeconds = resolveNotificationLeaseSeconds(options.notificationLeaseSeconds);
  const noticeColumns = resolveNoticeColumns(options);

  const vault = await getVaultRecordByUserId(sql, engineSchema, appSchema, normalizedSubjectId, rootTable);
  if (!vault) {
    fail({
      code: "DPDP_VAULT_NOT_FOUND",
      title: "Vault record not found",
      detail: `Vault record not found for ${appSchema}.${rootTable}#${normalizedSubjectId}.`,
      category: "validation",
      retryable: false,
    });
  }

  if (options.dryRun) {
    return {
      action: "dry_run",
      userHash: vault.user_uuid_hash,
      dryRun: true,
      retentionExpiry: vault.retention_expiry.toISOString(),
      notificationDueAt: vault.notification_due_at.toISOString(),
      notificationSentAt: vault.notification_sent_at ? vault.notification_sent_at.toISOString() : null,
      outboxEventType: "NOTIFICATION_SENT",
      plan: buildNoticeDryRunPlan(
        appSchema,
        engineSchema,
        rootTable,
        normalizedSubjectId,
        vault.user_uuid_hash,
        new Date(vault.notification_due_at),
        new Date(vault.retention_expiry)
      ),
    };
  }

  let encryptedDek: Uint8Array | null = null;
  let dek: Uint8Array | null = null;
  let encryptedPayload: Uint8Array | null = null;
  let decryptedPiiBytes: Uint8Array | null = null;
  let lockId: string | null = null;

  try {
    const reservation = await reserveNotice(
      sql,
      engineSchema,
      appSchema,
      rootTable,
      normalizedSubjectId,
      now,
      leaseSeconds
    );
    if (reservation.action === "already_sent") {
      return {
        action: "already_sent",
        userHash: reservation.vault.user_uuid_hash,
        dryRun: false,
        retentionExpiry: reservation.vault.retention_expiry.toISOString(),
        notificationDueAt: reservation.vault.notification_due_at.toISOString(),
        notificationSentAt: reservation.vault.notification_sent_at?.toISOString() ?? null,
        outboxEventType: null,
      };
    }

    if (reservation.action === "not_due") {
      return {
        action: "not_due",
        userHash: reservation.vault.user_uuid_hash,
        dryRun: false,
        retentionExpiry: reservation.vault.retention_expiry.toISOString(),
        notificationDueAt: new Date(reservation.vault.notification_due_at).toISOString(),
        notificationSentAt: null,
        outboxEventType: null,
      };
    }

    lockId = reservation.lockId!;
    encryptedDek = reservation.encryptedDek!;
    dek = await unwrapKey(encryptedDek, kek);

    const payload = reservation.vault.encrypted_pii;
    if (payload.destroyed || !payload.data) {
      fail({
        code: "DPDP_NOTIFICATION_PAYLOAD_DESTROYED",
        title: "Vault payload is no longer decryptable",
        detail: `Vault payload for root row ${normalizedSubjectId} no longer contains decryptable PII.`,
        category: "integrity",
        retryable: false,
      });
    }

    encryptedPayload = new Uint8Array(Buffer.from(payload.data, "base64"));
    decryptedPiiBytes = await decryptGCMBytes(encryptedPayload, dek);
    const parsed = JSON.parse(textDecoder.decode(decryptedPiiBytes)) as Record<string, unknown>;
    const emailCandidate = parsed[noticeColumns.emailColumn];
    const email = typeof emailCandidate === "string" && emailCandidate.trim().length > 0 ? emailCandidate.trim() : null;
    if (!email) {
      fail({
        code: "DPDP_NOTIFICATION_EMAIL_MISSING",
        title: "Notification email address missing",
        detail: `Vault payload for root row ${normalizedSubjectId} does not contain ${noticeColumns.emailColumn}.`,
        category: "integrity",
        retryable: false,
      });
    }

    const nameCandidate = noticeColumns.nameColumn ? parsed[noticeColumns.nameColumn] : undefined;
    const fullName = typeof nameCandidate === "string" && nameCandidate.trim().length > 0 ? nameCandidate.trim() : "User";

    const mailIdempotencyKey = buildNotificationIdempotencyKey(reservation.vault);
    await mailer.sendEmail({
      to: email,
      subject: "Notice of Permanent Data Erasure",
      body: `Dear ${fullName},\n\nYour data will be permanently anonymized in 48 hours in compliance with the DPDP Act.`,
      idempotencyKey: mailIdempotencyKey,
    });

    await sql.begin("isolation level repeatable read", async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '5s'");

      const updated = await tx`
        UPDATE ${tx(engineSchema)}.pii_vault
        SET notification_sent_at = ${now},
            notification_lock_id = NULL,
            notification_lock_expires_at = NULL,
            updated_at = ${now}
        WHERE user_uuid_hash = ${reservation.vault.user_uuid_hash}
          AND notification_lock_id = ${lockId}
          AND notification_sent_at IS NULL
        RETURNING user_uuid_hash
      `;

      if (updated.length === 0) {
        fail({
          code: "DPDP_NOTIFICATION_LEASE_LOST",
          title: "Notification lease lost",
          detail: `Notification lease for root row ${normalizedSubjectId} was lost before completion.`,
          category: "concurrency",
          retryable: true,
        });
      }

      await enqueueOutboxEvent(
        tx,
        engineSchema,
        reservation.vault.user_uuid_hash,
        "NOTIFICATION_SENT",
        {
          request_id: reservation.vault.request_id,
          subject_opaque_id: reservation.vault.root_id,
          tenant_id: reservation.vault.tenant_id || null,
          trigger_source: reservation.vault.trigger_source,
          legal_framework: reservation.vault.legal_framework,
          actor_opaque_id: reservation.vault.actor_opaque_id,
          applied_rule_name: reservation.vault.applied_rule_name,
          event_timestamp: now.toISOString(),
          root_schema: appSchema,
          root_table: rootTable,
          root_id: normalizedSubjectId,
          sent_at: now.toISOString(),
        },
        reservation.vault.request_id
          ? `notice:${reservation.vault.request_id}`
          : `notice:${appSchema}:${rootTable}:${normalizedSubjectId}`,
        now
      );
    });

    logger.info(
      {
        userHash: reservation.vault.user_uuid_hash,
        rootTable,
        rootId: normalizedSubjectId,
      },
      "Pre-erasure notice sent"
    );

    return {
      action: "sent",
      userHash: reservation.vault.user_uuid_hash,
      dryRun: false,
      retentionExpiry: reservation.vault.retention_expiry.toISOString(),
      notificationDueAt: reservation.vault.notification_due_at.toISOString(),
      notificationSentAt: now.toISOString(),
      outboxEventType: "NOTIFICATION_SENT",
    };
  } catch (error) {
    if (lockId && vault.user_uuid_hash) {
      try {
        await clearNoticeLease(sql, engineSchema, vault.user_uuid_hash, lockId, now);
      } catch (leaseError) {
        logError(logger, leaseError, "Failed to clear notification lease after notifier error", {
          userHash: vault.user_uuid_hash,
          rootTable,
          rootId: normalizedSubjectId,
        });
      }
    }

    throw error;
  } finally {
    encryptedDek?.fill(0);
    dek?.fill(0);
    encryptedPayload?.fill(0);
    decryptedPiiBytes?.fill(0);
  }
}
