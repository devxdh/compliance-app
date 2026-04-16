# Technical Design Document

## Main Modules

### `src/config/worker.ts`

- Validates worker environment variables.
- Decodes KEK/HMAC keys from hex or base64.
- Rejects bad schema names and invalid numeric settings early.

### `src/db/graph.ts`

- Verifies that the requested root table exists.
- Walks FK relationships recursively.
- Prevents cycle inflation by tracking visited table OIDs.
- Throws if traversal reaches the configured depth limit.

### `src/db/migrations.ts`

- Creates the worker schema and tables.
- Adds indexes needed for lookup and retry scans.
- Stores notice/shred metadata in `pii_vault`.
- Stores delivery state in `outbox`.

### `src/engine/vault.ts`

- Validates inputs and worker secrets.
- Computes retention window metadata.
- Supports dry-run output.
- Performs an atomic transaction:
  - lock user row,
  - hard delete if safe,
  - or encrypt PII, store vault/key rows, pseudonymize public row, enqueue outbox event.

### `src/engine/notifier.ts`

- Reserves the vault row with a short notification lease.
- Decrypts the payload in memory only.
- Sends mail via injected transport.
- Clears the lease on failure.
- Marks completion and enqueues the outbox event on success.

### `src/engine/shredder.ts`

- Verifies retention expiry.
- Verifies notice completion unless explicitly disabled.
- Deletes the DEK.
- Replaces ciphertext with `{ "v": 1, "destroyed": true }`.
- Enqueues the shred event.

### `src/network/outbox.ts`

- Claims due events with `FOR UPDATE SKIP LOCKED`.
- Marks claimed rows as `leased`.
- Processes them outside the claim transaction.
- Marks success as `processed`.
- Requeues failures with exponential backoff.
- Moves exhausted retries to `dead_letter`.

## Test Strategy

- Crypto/config unit tests.
- PostgreSQL-backed integration tests for graph, vault, notice, shred, and outbox behavior.
- Injected clocks for deterministic timing tests.
- Injected mail/API transports for side-effect testing.
