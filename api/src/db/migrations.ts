import type postgres from "postgres";
import { assertIdentifier } from "./identifiers";

/**
 * Provisions the control-plane schema and tables.
 *
 * @param sql - Postgres connection pool.
 * @param controlSchema - Target schema name for control-plane tables.
 * @returns Promise resolved once all DDL has been applied.
 * @throws {ApiError} When schema identifier validation fails.
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
        display_name TEXT,
        current_key_id TEXT NOT NULL DEFAULT 'bootstrap',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        shadow_success_count INTEGER NOT NULL DEFAULT 0,
        shadow_required_successes INTEGER NOT NULL DEFAULT 100,
        live_mutation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        live_mutation_enabled_at TIMESTAMPTZ,
        rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_authenticated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await tx`
      ALTER TABLE ${tx(safeSchema)}.clients
      ADD COLUMN IF NOT EXISTS display_name TEXT,
      ADD COLUMN IF NOT EXISTS current_key_id TEXT NOT NULL DEFAULT 'bootstrap',
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS shadow_success_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS shadow_required_successes INTEGER NOT NULL DEFAULT 100,
      ADD COLUMN IF NOT EXISTS live_mutation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS live_mutation_enabled_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS last_authenticated_at TIMESTAMPTZ
    `;

    await tx`
      CREATE TABLE IF NOT EXISTS ${tx(safeSchema)}.erasure_jobs (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES ${tx(safeSchema)}.clients(id) ON DELETE CASCADE,
        idempotency_key UUID NOT NULL UNIQUE,
        subject_opaque_id TEXT NOT NULL,
        trigger_source TEXT NOT NULL,
        actor_opaque_id TEXT NOT NULL,
        legal_framework TEXT NOT NULL,
        applied_rule_name TEXT,
        applied_rule_citation TEXT,
        request_timestamp TIMESTAMPTZ NOT NULL,
        tenant_id TEXT,
        cooldown_days INTEGER NOT NULL,
        shadow_mode BOOLEAN NOT NULL DEFAULT FALSE,
        webhook_url TEXT,
        status TEXT NOT NULL,
        vault_due_at TIMESTAMPTZ NOT NULL,
        notification_due_at TIMESTAMPTZ,
        shred_due_at TIMESTAMPTZ,
        shredded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await tx`
      ALTER TABLE ${tx(safeSchema)}.erasure_jobs
      ADD COLUMN IF NOT EXISTS idempotency_key UUID,
      ADD COLUMN IF NOT EXISTS subject_opaque_id TEXT,
      ADD COLUMN IF NOT EXISTS trigger_source TEXT,
      ADD COLUMN IF NOT EXISTS actor_opaque_id TEXT,
      ADD COLUMN IF NOT EXISTS legal_framework TEXT,
      ADD COLUMN IF NOT EXISTS applied_rule_name TEXT,
      ADD COLUMN IF NOT EXISTS applied_rule_citation TEXT,
      ADD COLUMN IF NOT EXISTS request_timestamp TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS tenant_id TEXT,
      ADD COLUMN IF NOT EXISTS cooldown_days INTEGER,
      ADD COLUMN IF NOT EXISTS shadow_mode BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS webhook_url TEXT,
      ADD COLUMN IF NOT EXISTS vault_due_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS notification_due_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS shred_due_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS shredded_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `;

    await tx`ALTER TABLE ${tx(safeSchema)}.erasure_jobs DROP CONSTRAINT IF EXISTS erasure_jobs_status_check`;
    await tx`
      ALTER TABLE ${tx(safeSchema)}.erasure_jobs
      ADD CONSTRAINT erasure_jobs_status_check
      CHECK (status IN ('WAITING_COOLDOWN', 'EXECUTING', 'VAULTED', 'NOTICE_SENT', 'SHREDDED', 'FAILED', 'CANCELLED'))
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
        shadow_burn_in_recorded_at TIMESTAMPTZ,
        error_text TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await tx`
      ALTER TABLE ${tx(safeSchema)}.task_queue
      ADD COLUMN IF NOT EXISTS worker_client_name TEXT,
      ADD COLUMN IF NOT EXISTS leased_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS shadow_burn_in_recorded_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS error_text TEXT,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `;

    await tx`ALTER TABLE ${tx(safeSchema)}.task_queue DROP CONSTRAINT IF EXISTS task_queue_status_check`;
    await tx`
      ALTER TABLE ${tx(safeSchema)}.task_queue
      ADD CONSTRAINT task_queue_status_check CHECK (status IN ('QUEUED', 'DISPATCHED', 'COMPLETED', 'FAILED', 'DEAD_LETTER'))
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
        subject_opaque_id TEXT NOT NULL,
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
      ALTER TABLE ${tx(safeSchema)}.certificates
      ADD COLUMN IF NOT EXISTS subject_opaque_id TEXT,
      ADD COLUMN IF NOT EXISTS method TEXT,
      ADD COLUMN IF NOT EXISTS legal_framework TEXT,
      ADD COLUMN IF NOT EXISTS shredded_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS payload JSONB,
      ADD COLUMN IF NOT EXISTS signature_base64 TEXT,
      ADD COLUMN IF NOT EXISTS public_key_spki_base64 TEXT,
      ADD COLUMN IF NOT EXISTS key_id TEXT,
      ADD COLUMN IF NOT EXISTS algorithm TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `;

    await tx`
      CREATE TABLE IF NOT EXISTS ${tx(safeSchema)}.usage_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        billing_key TEXT NOT NULL UNIQUE,
        client_id UUID NOT NULL REFERENCES ${tx(safeSchema)}.clients(id) ON DELETE CASCADE,
        erasure_job_id UUID REFERENCES ${tx(safeSchema)}.erasure_jobs(id) ON DELETE SET NULL,
        audit_ledger_id UUID REFERENCES ${tx(safeSchema)}.audit_ledger(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        units INTEGER NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurred_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS erasure_jobs_idempotency_key_idx
      ON ${tx(safeSchema)}.erasure_jobs (idempotency_key)
    `;

    await tx`
      CREATE INDEX IF NOT EXISTS erasure_jobs_due_status_idx
      ON ${tx(safeSchema)}.erasure_jobs (status, vault_due_at, created_at)
    `;

    await tx`
      CREATE INDEX IF NOT EXISTS erasure_jobs_notice_due_status_idx
      ON ${tx(safeSchema)}.erasure_jobs (status, notification_due_at, created_at)
    `;

    await tx`
      CREATE INDEX IF NOT EXISTS erasure_jobs_shred_due_status_idx
      ON ${tx(safeSchema)}.erasure_jobs (status, shred_due_at, created_at)
    `;

    await tx`DROP INDEX IF EXISTS ${tx(safeSchema)}.task_queue_claim_idx`;
    await tx`
      CREATE INDEX task_queue_claim_idx
      ON ${tx(safeSchema)}.task_queue (status, next_attempt_at, lease_expires_at, created_at)
    `;

    await tx`
      CREATE INDEX IF NOT EXISTS task_queue_job_idx
      ON ${tx(safeSchema)}.task_queue (erasure_job_id, status)
    `;

    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS task_queue_job_type_uidx
      ON ${tx(safeSchema)}.task_queue (erasure_job_id, task_type)
    `;

    await tx`
      CREATE INDEX IF NOT EXISTS task_queue_dead_letter_idx
      ON ${tx(safeSchema)}.task_queue (status, dead_lettered_at)
    `;

    await tx`
      CREATE INDEX IF NOT EXISTS audit_ledger_client_idx
      ON ${tx(safeSchema)}.audit_ledger (client_id, ledger_seq DESC)
    `;

    await tx`
      CREATE INDEX IF NOT EXISTS clients_active_name_idx
      ON ${tx(safeSchema)}.clients (is_active, name)
    `;

    await tx`
      CREATE INDEX IF NOT EXISTS usage_events_client_occurred_idx
      ON ${tx(safeSchema)}.usage_events (client_id, occurred_at DESC)
    `;

    await tx`
      CREATE INDEX IF NOT EXISTS usage_events_event_type_idx
      ON ${tx(safeSchema)}.usage_events (event_type, occurred_at DESC)
    `;
  });
}
