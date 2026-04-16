import { sql } from './index';

export async function setupDatabase() {
  await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`;

  await sql`
    CREATE TABLE IF NOT EXISTS pending_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      lease_token UUID,
      lease_expires_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      result JSONB,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT pending_tasks_status_check CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'cancelled'))
    )
  `;

  await sql`
    ALTER TABLE pending_tasks
    ADD COLUMN IF NOT EXISTS lease_token UUID,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS result JSONB,
    ADD COLUMN IF NOT EXISTS last_error TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS worker_outbox_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id TEXT NOT NULL,
      idempotency_key TEXT,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    )
  `;

  await sql`
    ALTER TABLE worker_outbox_events
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_pending_tasks_lookup
    ON pending_tasks (client_id, status, created_at, lease_expires_at)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_worker_outbox_client
    ON worker_outbox_events (client_id, received_at DESC)
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_outbox_idempotency
    ON worker_outbox_events (client_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `;
}

export async function teardownDatabase() {
  // Removed DROP TABLE to prevent race conditions during parallel test execution.
}
