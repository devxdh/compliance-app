import postgres from "postgres";
import { asWorkerError, fail } from "../errors";
import {
  calculateRetryDelayMs,
  type OutboxEvent,
} from "./outbox.shared";

/**
 * Claims one leased batch of due outbox events.
 *
 * @param sql - Postgres pool owning the outbox table.
 * @param engineSchema - Worker engine schema.
 * @param batchSize - Maximum rows to claim.
 * @param leaseSeconds - Lease duration in seconds.
 * @param now - Lease anchor timestamp.
 * @returns Lease token plus claimed events.
 */
export async function claimOutboxBatch(
  sql: postgres.Sql,
  engineSchema: string,
  batchSize: number,
  leaseSeconds: number,
  now: Date
): Promise<{ leaseToken: string; events: OutboxEvent[] }> {
  return sql.begin(async (tx) => {
    const leaseToken = globalThis.crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);

    const events = await tx<OutboxEvent[]>`
      SELECT *
      FROM ${tx(engineSchema)}.outbox
      WHERE status IN ('pending', 'leased')
        AND next_attempt_at <= ${now}
        AND (status = 'pending' OR lease_expires_at IS NULL OR lease_expires_at <= ${now})
      ORDER BY created_at ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;

    for (const event of events) {
      await tx`
        UPDATE ${tx(engineSchema)}.outbox
        SET status = 'leased',
            lease_token = ${leaseToken},
            lease_expires_at = ${leaseExpiresAt},
            updated_at = ${now}
        WHERE id = ${event.id}
      `;

      event.status = "leased";
      event.lease_token = leaseToken;
      event.lease_expires_at = leaseExpiresAt;
      event.updated_at = now;
    }

    return {
      leaseToken,
      events,
    };
  });
}

/**
 * Marks a leased outbox event as processed.
 *
 * @param sql - Postgres pool owning the outbox table.
 * @param engineSchema - Worker engine schema.
 * @param eventId - Outbox event id.
 * @param leaseToken - Current lease token.
 * @param now - Update timestamp.
 */
export async function markOutboxEventProcessed(
  sql: postgres.Sql,
  engineSchema: string,
  eventId: string,
  leaseToken: string,
  now: Date
): Promise<void> {
  const updated = await sql`
    UPDATE ${sql(engineSchema)}.outbox
    SET status = 'processed',
        processed_at = ${now},
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error = NULL,
        updated_at = ${now}
    WHERE id = ${eventId}
      AND lease_token = ${leaseToken}
      AND status = 'leased'
    RETURNING id
  `;

  if (updated.length === 0) {
    fail({
      code: "DPDP_OUTBOX_LEASE_LOST",
      title: "Outbox lease lost",
      detail: `Outbox lease for event ${eventId} was lost before it could be marked processed.`,
      category: "concurrency",
      retryable: true,
      context: { eventId },
    });
  }
}

/**
 * Marks a leased outbox event as failed or dead-lettered.
 *
 * @param sql - Postgres pool owning the outbox table.
 * @param engineSchema - Worker engine schema.
 * @param event - Leased outbox event.
 * @param leaseToken - Current lease token.
 * @param now - Update timestamp.
 * @param maxAttempts - Retry ceiling before dead-lettering.
 * @param baseBackoffMs - Initial exponential backoff.
 * @param error - Original delivery error.
 * @returns Resulting queue state.
 */
export async function markOutboxEventFailed(
  sql: postgres.Sql,
  engineSchema: string,
  event: OutboxEvent,
  leaseToken: string,
  now: Date,
  maxAttempts: number,
  baseBackoffMs: number,
  error: unknown
): Promise<"pending" | "dead_letter"> {
  const nextAttemptCount = event.attempt_count + 1;
  const deadLetter = nextAttemptCount >= maxAttempts;
  const nextAttemptAt = new Date(
    now.getTime() + calculateRetryDelayMs(nextAttemptCount, baseBackoffMs)
  );
  const errorMessage = error instanceof Error ? error.message : String(error);

  const updated = await sql`
    UPDATE ${sql(engineSchema)}.outbox
    SET status = ${deadLetter ? "dead_letter" : "pending"},
        attempt_count = ${nextAttemptCount},
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = ${deadLetter ? now : nextAttemptAt},
        last_error = ${errorMessage.slice(0, 1024)},
        updated_at = ${now}
    WHERE id = ${event.id}
      AND lease_token = ${leaseToken}
      AND status = 'leased'
    RETURNING id
  `;

  if (updated.length === 0) {
    fail({
      code: "DPDP_OUTBOX_LEASE_LOST",
      title: "Outbox lease lost",
      detail: `Outbox lease for event ${event.id} was lost before it could be retried.`,
      category: "concurrency",
      retryable: true,
      context: { eventId: event.id },
    });
  }

  return deadLetter ? "dead_letter" : "pending";
}

/**
 * Releases a leased outbox event back to pending state after a fatal delivery failure.
 *
 * @param sql - Postgres pool owning the outbox table.
 * @param engineSchema - Worker engine schema.
 * @param eventId - Outbox event id.
 * @param leaseToken - Current lease token.
 * @param now - Update timestamp.
 * @param error - Fatal delivery error.
 */
export async function releaseOutboxLease(
  sql: postgres.Sql,
  engineSchema: string,
  eventId: string,
  leaseToken: string,
  now: Date,
  error: unknown
): Promise<void> {
  const normalized = asWorkerError(error);

  const updated = await sql`
    UPDATE ${sql(engineSchema)}.outbox
    SET status = 'pending',
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = ${now},
        last_error = ${normalized.detail.slice(0, 1024)},
        updated_at = ${now}
    WHERE id = ${eventId}
      AND lease_token = ${leaseToken}
      AND status = 'leased'
    RETURNING id
  `;

  if (updated.length === 0) {
    fail({
      code: "DPDP_OUTBOX_LEASE_LOST",
      title: "Outbox lease lost",
      detail: `Outbox lease for event ${eventId} was lost before it could be released.`,
      category: "concurrency",
      retryable: true,
      context: { eventId },
    });
  }
}
