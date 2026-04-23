import type { VaultRecord } from "../support";

/**
 * Normalized mail message emitted by the pre-erasure notifier.
 */
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

/**
 * Result of reserving a pre-erasure notice slot on a vault row.
 */
export interface NoticeReservation {
  action: "send" | "already_sent" | "not_due";
  vault: VaultRecord;
  encryptedDek?: Uint8Array;
  lockId?: string;
}
