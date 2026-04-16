/**
 * MODULE 5: THE NOTIFICATION HANDSHAKE
 *
 * Expert view:
 * Notifications are side effects. That means we need explicit leasing and
 * idempotent completion semantics, otherwise retries or concurrent workers can
 * double-send emails.
 *
 * Layman view:
 * Before the final erase, the worker temporarily checks the sealed record,
 * sends the warning email, and marks that warning as finished. We put a short
 * "reservation" on the record first so two workers do not send the same notice.
 */

import postgres from "postgres";
import { decryptGCM } from "../crypto/aes";
import { unwrapKey } from "../crypto/envelope";
import type { DispatchNoticeOptions, DispatchNoticeResult, WorkerSecrets } from "./contracts";
import {
  assertWorkerSecrets,
  enqueueOutboxEvent,
  getVaultRecordByUserId,
  resolveSchemas,
} from "./support";
import type { VaultRecord } from "./support";

export interface MockMailer {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
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
    throw new Error("notificationLeaseSeconds must be an integer greater than 0.");
  }

  return value;
}

function buildNoticeDryRunPlan(
  appSchema: string,
  engineSchema: string,
  userId: number,
  userHash: string,
  notificationDueAt: Date,
  retentionExpiry: Date
) {
  return {
    mode: "dry-run" as const,
    summary: `Would attempt the pre-erasure notice for user ${userId} (${userHash}).`,
    checks: [
      `Read ${engineSchema}.pii_vault using (${appSchema}, users, ${userId}) as the lookup key.`,
      `Verify that now is between notification_due_at (${notificationDueAt.toISOString()}) and retention_expiry (${retentionExpiry.toISOString()}).`,
      "Acquire a short notification lease before decrypting or sending mail.",
      "Write the outbox event only after the mailer succeeds.",
    ],
    cryptoSteps: [
      "Unwrap the stored DEK with the worker KEK.",
      "Decrypt the vaulted JSON payload in memory only.",
      "Null and overwrite temporary buffers after the email path completes.",
    ],
    sqlSteps: [
      `SELECT * FROM ${engineSchema}.pii_vault WHERE root_schema = '${appSchema}' AND root_table = 'users' AND root_id = '${userId}' FOR UPDATE;`,
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
  userId: number,
  now: Date,
  leaseSeconds: number
): Promise<NoticeReservation> {
  return sql.begin(async (tx) => {
    const [vault] = await tx<VaultRecord[]>`
      SELECT *
      FROM ${tx(engineSchema)}.pii_vault
      WHERE root_schema = ${appSchema}
        AND root_table = 'users'
        AND root_id = ${userId.toString()}
      FOR UPDATE
    `;

    if (!vault) {
      throw new Error(`Vault record not found for ${appSchema}.users#${userId}.`);
    }

    if (vault.shredded_at) {
      throw new Error(`Cannot dispatch notice for user ${userId}: the vault has already been shredded.`);
    }

    if (vault.notification_sent_at) {
      return { action: "already_sent", vault };
    }

    if (now < new Date(vault.notification_due_at)) {
      return { action: "not_due", vault };
    }

    if (now >= new Date(vault.retention_expiry)) {
      throw new Error(`Cannot dispatch notice for user ${userId}: the retention deadline has already expired.`);
    }

    if (vault.notification_lock_expires_at && new Date(vault.notification_lock_expires_at) > now) {
      throw new Error(`Notification for user ${userId} is already leased by another worker.`);
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
      throw new Error(`Key Ring record not found for user hash ${vault.user_uuid_hash}.`);
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
 * Dispatches the pre-erasure notice securely.
 */
export async function dispatchPreErasureNotice(
  sql: postgres.Sql,
  userId: number,
  secrets: WorkerSecrets,
  mailer: MockMailer,
  options: DispatchNoticeOptions = {}
): Promise<DispatchNoticeResult> {
  if (!Number.isInteger(userId) || userId < 1) {
    throw new Error("userId must be a positive integer.");
  }

  const { appSchema, engineSchema } = resolveSchemas(options);
  const { kek } = assertWorkerSecrets(secrets);
  const now = options.now ? new Date(options.now) : new Date();
  const leaseSeconds = resolveNotificationLeaseSeconds(options.notificationLeaseSeconds);

  const vault = await getVaultRecordByUserId(sql, engineSchema, appSchema, userId);
  if (!vault) {
    throw new Error(`Vault record not found for ${appSchema}.users#${userId}.`);
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
        userId,
        vault.user_uuid_hash,
        new Date(vault.notification_due_at),
        new Date(vault.retention_expiry)
      ),
    };
  }

  console.log(`--- DISPATCHING PRE-ERASURE NOTICE FOR USER #${userId} ---`);

  let encryptedDek: Uint8Array | null = null;
  let dek: Uint8Array | null = null;
  let encryptedPayload: Uint8Array | null = null;
  let decryptedPii = "";
  let lockId: string | null = null;

  try {
    const reservation = await reserveNotice(sql, engineSchema, appSchema, userId, now, leaseSeconds);
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
      const dueAt = new Date(reservation.vault.notification_due_at);

      return {
        action: "not_due",
        userHash: reservation.vault.user_uuid_hash,
        dryRun: false,
        retentionExpiry: reservation.vault.retention_expiry.toISOString(),
        notificationDueAt: dueAt.toISOString(),
        notificationSentAt: null,
        outboxEventType: null,
      };
    }

    lockId = reservation.lockId!;
    encryptedDek = reservation.encryptedDek!;
    dek = await unwrapKey(encryptedDek, kek);

    const payload = reservation.vault.encrypted_pii;
    if (payload.destroyed || !payload.data) {
      throw new Error(`Vault payload for user ${userId} no longer contains decryptable PII.`);
    }

    encryptedPayload = new Uint8Array(Buffer.from(payload.data, "base64"));
    decryptedPii = await decryptGCM(encryptedPayload, dek);

    const parsed = JSON.parse(decryptedPii) as { email?: string; full_name?: string };
    if (!parsed.email) {
      throw new Error(`Vault payload for user ${userId} does not contain an email address.`);
    }

    await mailer.sendEmail(
      parsed.email,
      "Notice of Permanent Data Erasure",
      `Dear ${parsed.full_name || "User"},\n\nYour data will be permanently anonymized in 48 hours in compliance with the DPDP Act.`
    );

    await sql.begin(async (tx) => {
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
        throw new Error(`Notification lease for user ${userId} was lost before completion.`);
      }

      await enqueueOutboxEvent(
        tx,
        engineSchema,
        reservation.vault.user_uuid_hash,
        "NOTIFICATION_SENT",
        {
          rootSchema: appSchema,
          rootTable: "users",
          rootId: userId.toString(),
          sentAt: now.toISOString(),
        },
        `notice:${appSchema}:users:${userId}`,
        now
      );
    });

    console.log(`[SUCCESS]: Notification sent to User #${userId}`);

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
      await clearNoticeLease(sql, engineSchema, vault.user_uuid_hash, lockId, now);
    }

    throw error;
  } finally {
    encryptedDek?.fill(0);
    dek?.fill(0);
    encryptedPayload?.fill(0);
    decryptedPii = "";
  }
}
