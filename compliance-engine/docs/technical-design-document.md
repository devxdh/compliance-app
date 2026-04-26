# Technical Design Document

## Main Modules

### `src/config/worker.ts`

- Parses `compliance.worker.yml` with strict Zod validation.
- Enforces DPO legal attestation, rule-level citations, root PII mappings, satellite targets, blob targets, and schema-hash configuration.
- Resolves KEK/HMAC keys from env/file or runtime KMS adapters.
- Rejects bad identifiers and invalid numeric settings early.

### `src/db/graph.ts`

- Verifies that the requested root table exists.
- Walks FK relationships recursively.
- Prevents cycle inflation by tracking visited table OIDs.
- Throws if traversal reaches the configured depth limit.
- Fails closed when unsafe FK actions such as `ON DELETE CASCADE`, `SET NULL`, or `SET DEFAULT` are detected.

### `src/db/migrations.ts`

- Creates the worker schema and tables.
- Adds indexes needed for lookup and retry scans.
- Stores notice/shred metadata in `pii_vault`.
- Stores delivery state in `outbox`.

### `src/db/drift.ts`

- Computes deterministic SHA-256 digests of `information_schema.columns` to protect worker boots against mutated target environments.

### `src/engine/support/`

- Builds stable worker hashes and dynamic identity values.
- Stores local vault rows.
- Implements `enqueueOutboxEvent` with tamper-evident hash chaining using canonical JSON, previous hash, and idempotency key.

### `src/engine/vault/`

- Validates inputs and worker secrets.
- Locks the root row before graph traversal in live mode.
- Evaluates evidence-based retention rules and carries rule citations into vault/outbox records.
- Supports dry-run and shadow-mode rollback output.
- Performs an atomic transaction:
  - set local lock timeout,
  - lock root row,
  - hard delete if safe,
  - or encrypt PII, store vault/key rows, pseudonymize public row, process satellite/blob targets, enqueue outbox event.

### `src/engine/notifier/`

- Reserves the vault row with a short notification lease.
- Decrypts the payload into wipeable bytes and extracts configured notification fields.
- Sends mail via injected transport.
- Clears the lease on failure.
- Marks completion and enqueues the outbox event on success.

### `src/engine/shredder.ts`

- Verifies retention expiry.
- Verifies notice completion unless explicitly disabled.
- Deletes the DEK.
- Replaces ciphertext with `{ "v": 1, "destroyed": true }`.
- Enqueues the shred event.

### `src/engine/blob/`

- Extracts configured S3 object URLs.
- Applies legal hold during vaulting.
- Stores raw object coordinates only in the local engine schema.
- Purges all versions/delete markers during shredding and sends only HMACed receipts.

### `src/network/outbox/`

- Claims due events with `FOR UPDATE SKIP LOCKED`.
- Marks claimed rows as `leased`.
- Processes them outside the claim transaction.
- Marks success as `processed`.
- Requeues failures with exponential backoff.
- Moves exhausted retries to `dead_letter`.
- Prioritizes terminal legal events during catch-up.

### `src/index.ts`

- Verifies signed worker config.
- Starts health, readiness, and Prometheus metrics endpoints.
- Wires Control Plane sync/ack/outbox transport, mailer webhook transport, optional S3 client, and primary/replica Postgres pools.

## Test Strategy

- Crypto/config unit tests.
- PostgreSQL-backed integration tests for graph, vault, notice, shred, and outbox behavior.
- Injected clocks for deterministic timing tests.
- Injected mail/API transports for side-effect testing.
