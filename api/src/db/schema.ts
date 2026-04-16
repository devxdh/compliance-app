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
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS worker_outbox_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      processed_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_pending_tasks_lookup
    ON pending_tasks (client_id, status, created_at)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_worker_outbox_client
    ON worker_outbox_events (client_id, processed_at DESC)
  `;
}

export async function teardownDatabase() {
  // Removed DROP TABLE to prevent race conditions during parallel test execution.
}
