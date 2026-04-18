/**
 * Layman Terms:
 * Building the Security Room. Before the guard can work, they build a locked, private 
 * security room inside the main building. In this room, they build three things:
 * 1. The Vault (where names and emails are locked).
 * 2. The Key Cabinet (where physical keys to the vaults are stored).
 * 3. The Mailroom Outbox (a tray for notes to the mailman).
 *
 * Technical Terms:
 * Provisions the internal state schema (`dpdp_engine`).
 * Creates `pii_vault` for durable state machine timestamps and encrypted PII.
 * Creates `user_keys` with `ON DELETE CASCADE` attached to the vault to ensure 
 * foreign-key-based crypto-shredding capability. 
 * Creates `outbox` for the Transactional Outbox pattern, with indexes optimized 
 * for queue polling (retries and leases).
 */

import postgres from "postgres";
import { assertIdentifier } from "./identifiers";
import { getLogger } from "../observability/logger";

const logger = getLogger({ component: "migrations" });

export async function runMigrations(sql: postgres.Sql, engineSchema: string = "dpdp_engine") {
  const safeEngineSchema = assertIdentifier(engineSchema, "engine schema name");

  logger.info({ engineSchema: safeEngineSchema }, "Provisioning DPDP engine schema");

  await sql.begin(async (tx) => {
    await tx`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
    await tx`CREATE SCHEMA IF NOT EXISTS ${tx(safeEngineSchema)}`;

    await tx`
      CREATE TABLE IF NOT EXISTS ${tx(safeEngineSchema)}.pii_vault (
        user_uuid_hash TEXT PRIMARY KEY,
        root_schema TEXT NOT NULL,
        root_table TEXT NOT NULL,
        root_id TEXT NOT NULL,
        pseudonym TEXT NOT NULL,
        encrypted_pii JSONB NOT NULL,
        salt TEXT NOT NULL,
        dependency_count INTEGER NOT NULL DEFAULT 0,
        retention_expiry TIMESTAMPTZ NOT NULL,
        notification_due_at TIMESTAMPTZ NOT NULL,
        notification_sent_at TIMESTAMPTZ,
        notification_lock_id UUID,
        notification_lock_expires_at TIMESTAMPTZ,
        shredded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await tx`
      ALTER TABLE ${tx(safeEngineSchema)}.pii_vault
      ADD COLUMN IF NOT EXISTS root_schema TEXT,
      ADD COLUMN IF NOT EXISTS root_table TEXT,
      ADD COLUMN IF NOT EXISTS root_id TEXT,
      ADD COLUMN IF NOT EXISTS pseudonym TEXT,
      ADD COLUMN IF NOT EXISTS dependency_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS notification_due_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS notification_sent_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS notification_lock_id UUID,
      ADD COLUMN IF NOT EXISTS notification_lock_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS shredded_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `;

    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS pii_vault_root_lookup_idx
      ON ${tx(safeEngineSchema)}.pii_vault (root_schema, root_table, root_id)
    `;

    await tx`
      CREATE INDEX IF NOT EXISTS pii_vault_retention_idx
      ON ${tx(safeEngineSchema)}.pii_vault (retention_expiry, notification_due_at)
    `;

    await tx`
      CREATE TABLE IF NOT EXISTS ${tx(safeEngineSchema)}.user_keys (
        user_uuid_hash TEXT PRIMARY KEY REFERENCES ${tx(safeEngineSchema)}.pii_vault(user_uuid_hash) ON DELETE CASCADE,
        encrypted_dek BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await tx`
      CREATE TABLE IF NOT EXISTS ${tx(safeEngineSchema)}.outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_key TEXT NOT NULL UNIQUE,
        user_uuid_hash TEXT NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        payload JSONB NOT NULL,
        previous_hash TEXT NOT NULL,
        current_hash TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_token UUID,
        lease_expires_at TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT outbox_status_check CHECK (status IN ('pending', 'leased', 'processed', 'dead_letter'))
      )
    `;

    await tx`
      ALTER TABLE ${tx(safeEngineSchema)}.outbox
      ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
      ADD COLUMN IF NOT EXISTS previous_hash TEXT,
      ADD COLUMN IF NOT EXISTS current_hash TEXT,
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS lease_token UUID,
      ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_error TEXT,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `;

    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS outbox_idempotency_key_idx
      ON ${tx(safeEngineSchema)}.outbox (idempotency_key)
    `;

    await tx`
      CREATE INDEX IF NOT EXISTS outbox_due_events_idx
      ON ${tx(safeEngineSchema)}.outbox (status, next_attempt_at, created_at)
    `;

    await tx`
      CREATE INDEX IF NOT EXISTS outbox_chain_tail_idx
      ON ${tx(safeEngineSchema)}.outbox (created_at DESC, id DESC)
      INCLUDE (current_hash)
      WHERE current_hash IS NOT NULL
    `;
  });

  logger.info({ engineSchema: safeEngineSchema }, "DPDP engine schema provisioned");
}
