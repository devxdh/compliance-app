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
      CREATE TABLE IF NOT EXISTS ${tx(safeSchema)}.clients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        worker_api_key_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await tx`
      CREATE TABLE IF NOT EXISTS ${tx(safeSchema)}.erasure_jobs (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES ${tx(safeSchema)}.clients(id) ON DELETE CASCADE,
        client_internal_user_id TEXT NOT NULL,
        user_uuid_hash TEXT NOT NULL,
        legal_basis TEXT NOT NULL,
        retention_years INTEGER NOT NULL,
        status TEXT NOT NULL,
        vault_due_at TIMESTAMPTZ,
        shred_due_at TIMESTAMPTZ,
        shredded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT erasure_jobs_status_check CHECK (status IN ('REQUESTED', 'VAULTED', 'NOTICE_SENT', 'SHREDDED', 'FAILED'))
      )
    `;

    await tx`
      CREATE TABLE IF NOT EXISTS ${tx(safeSchema)}.task_queue (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES ${tx(safeSchema)}.clients(id) ON DELETE CASCADE,
        erasure_job_id UUID NOT NULL REFERENCES ${tx(safeSchema)}.erasure_jobs(id) ON DELETE CASCADE,
        task_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL,
        worker_client_name TEXT,
        leased_at TIMESTAMPTZ,
        lease_expires_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error_text TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT task_queue_status_check CHECK (status IN ('QUEUED', 'DISPATCHED', 'COMPLETED', 'FAILED'))
      )
    `;

    await tx`
      CREATE TABLE IF NOT EXISTS ${tx(safeSchema)}.audit_ledger (
        ledger_seq BIGINT GENERATED ALWAYS AS IDENTITY,
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL REFERENCES ${tx(safeSchema)}.clients(id) ON DELETE CASCADE,
        worker_idempotency_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        previous_hash TEXT NOT NULL,
        current_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await tx`
      CREATE TABLE IF NOT EXISTS ${tx(safeSchema)}.certificates (
        request_id UUID PRIMARY KEY REFERENCES ${tx(safeSchema)}.erasure_jobs(id) ON DELETE CASCADE,
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
      CREATE INDEX IF NOT EXISTS task_queue_claim_idx
      ON ${tx(safeSchema)}.task_queue (status, lease_expires_at, created_at)
    `;

    await tx`
      CREATE INDEX IF NOT EXISTS audit_ledger_client_idx
      ON ${tx(safeSchema)}.audit_ledger (client_id, ledger_seq DESC)
    `;
  });
}
