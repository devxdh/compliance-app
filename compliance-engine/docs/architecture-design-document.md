# Architecture Design Document

## System Position

This repository is the **data plane** of the larger compliance system.

- The central API acts as the control plane.
- This worker performs local cryptographic and database mutations.
- The only outward-facing data path is the outbox relay.

## Core Design Choices

### 1. Envelope Encryption

- `DEK`: one per user, used to encrypt the PII payload.
- `KEK`: worker-level master key, expected from environment/config and never stored in the database.

Why:

- A database dump without the KEK does not reveal vaulted PII.

### 2. HMAC-Backed Worker Identifiers

- The worker stores `user_uuid_hash` as an HMAC-derived identifier rather than the raw public `id`.

Why:

- The worker can track jobs and outbox events without exposing a plain identifier in its own schema.

### 3. Recursive Graph Traversal Inside Postgres

- The FK graph is read from PostgreSQL system catalogs via a recursive CTE.

Why:

- Postgres already knows the schema graph.
- Database-side traversal avoids brittle application-side loops.
- The worker fails closed if the recursion reaches the configured safety limit.

### 4. Local State Machine In PostgreSQL

Important columns in `pii_vault`:

- `retention_expiry`
- `notification_due_at`
- `notification_sent_at`
- `notification_lock_id`
- `notification_lock_expires_at`
- `shredded_at`

Why:

- The worker must know exactly where a user is in the lifecycle.
- Idempotency and duplicate suppression require durable state, not transient in-memory checks.

### 5. Transactional Outbox With Leases

Outbox states:

- `pending`
- `leased`
- `processed`
- `dead_letter`

Why:

- Network delivery should not keep database row locks open.
- Another worker can reclaim expired leases safely.
- Permanent failures need a durable terminal state instead of infinite retries.

## State Flow

1. `vaultUser`
   - Either hard deletes immediately if the root table has no dependent tables, or stores encrypted PII and pseudonymizes the public row.
2. `dispatchPreErasureNotice`
   - Only runs inside the allowed time window and uses a lease to prevent duplicate sends.
3. `shredUser`
   - Requires expired retention and, by default, a sent notice.
   - Deletes the DEK and replaces ciphertext with a destroyed sentinel.
4. `processOutbox`
   - Delivers metadata to the control plane with retries and dead-letter support.
