import type postgres from "postgres";
import { assertIdentifier } from "./identifiers";

/**
 * Provisions the control-plane schema and tables.
 */
export async function migrateApiSchema(sql: postgres.Sql, controlSchema: string = "dpdp_control") {
  const safeSchema = assertIdentifier(controlSchema, "control schema name");

  await sql.begin(async (tx) => {
    await tx`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
    await tx`CREATE SCHEMA IF NOT EXISTS ${tx(safeSchema)}`;

    await tx`
      CREATE TABLE IF NOT EXISTS ${tx(safeSchema)}.erasure_requests (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        target_hash TEXT NOT NULL,
        legal_basis TEXT NOT NULL,
        retention_years INTEGER NOT NULL,
        status TEXT NOT NULL,
        shredded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT erasure_requests_status_check CHECK (status IN ('REQUESTED', 'VAULTED', 'NOTICE_SENT', 'SHREDDED', 'FAILED'))
      )
    `;

    await tx`
      CREATE TABLE IF NOT EXISTS ${tx(safeSchema)}.worker_tasks (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES ${tx(safeSchema)}.erasure_requests(id) ON DELETE CASCADE,
        worker_client_id TEXT,
        task_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL,
        leased_at TIMESTAMPTZ,
        lease_expires_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error_text TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT worker_tasks_status_check CHECK (status IN ('pending', 'leased', 'completed', 'failed'))
      )
    `;

    await tx`
      CREATE TABLE IF NOT EXISTS ${tx(safeSchema)}.worker_outbox_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_key TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL REFERENCES ${tx(safeSchema)}.erasure_requests(id) ON DELETE CASCADE,
        target_hash TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        event_timestamp TIMESTAMPTZ NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await tx`
      CREATE TABLE IF NOT EXISTS ${tx(safeSchema)}.certificates (
        request_id TEXT PRIMARY KEY REFERENCES ${tx(safeSchema)}.erasure_requests(id) ON DELETE CASCADE,
        target_hash TEXT NOT NULL,
        method TEXT NOT NULL,
        legal_framework TEXT NOT NULL,
        shredded_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL,
        signature_base64 TEXT NOT NULL,
        public_key_spki_base64 TEXT NOT NULL,
        key_id TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await tx`
      CREATE INDEX IF NOT EXISTS worker_tasks_claim_idx
      ON ${tx(safeSchema)}.worker_tasks (status, lease_expires_at, created_at)
    `;

    await tx`
      CREATE INDEX IF NOT EXISTS worker_outbox_request_idx
      ON ${tx(safeSchema)}.worker_outbox_events (request_id, event_timestamp)
    `;
  });
}

