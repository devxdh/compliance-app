import { sql } from './index';

export async function setupDatabase() {
  await sql`
    CREATE TABLE IF NOT EXISTS pending_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT DEFAULT 'pending',
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
}

export async function teardownDatabase() {
  // Removed DROP TABLE to prevent race conditions during parallel test execution.
}
