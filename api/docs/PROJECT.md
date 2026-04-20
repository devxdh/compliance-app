## Control Plane Project Reference

This document describes the current implementation in `api/src` for the Zero-Trust Control Plane.

### Boundary and Security Model

- The API is metadata-only and never accepts raw PII fields.
- Worker endpoints are authenticated using `x-client-id` + `Authorization: Bearer <token>`.
- Worker tokens are stored as SHA-256 hashes (`worker_api_key_hash`) using Web Crypto (`globalThis.crypto`).
- Outbox ingestion enforces WORM hash chaining and idempotency semantics.

### Runtime and Stack Constraints

- Runtime: Bun
- HTTP framework: Hono
- Validation: Zod + `@hono/zod-validator`
- Database access: `postgres.js` (no ORM)
- Crypto: native Web Crypto APIs only (`globalThis.crypto`)

### Database Topology (Control Schema)

Migrations in `src/db/migrations.ts` provision:

- `clients`: tenant registry and worker auth hash
- `erasure_jobs`: request lifecycle state machine
- `task_queue`: worker task leasing with lease expiry
- `audit_ledger`: tamper-evident worker event ledger (`previous_hash`, `current_hash`)
- `certificates`: immutable Certificate of Erasure payload + signature

Performance index highlights:

- `task_queue_claim_idx` for queue claim scans
- `audit_ledger_client_idx` on `(client_id, ledger_seq DESC)` for O(1) chain-head lookup

### API Lifecycle

1. `POST /api/v1/erasure-requests`
   - Registers erasure job and enqueues worker task in one transactional path.
2. `GET /api/v1/worker/sync`
   - Claims next available task using `FOR UPDATE SKIP LOCKED`.
   - Called by the worker in a bounded 5-second short-poll loop rather than a held long-poll request.
3. `POST /api/v1/worker/tasks/:taskId/ack`
   - Marks task `COMPLETED`/`FAILED` and advances job state.
4. `POST /api/v1/worker/outbox`
   - Validates hash chain + payload limits + client ownership.
   - Ingests WORM event with `ON CONFLICT (worker_idempotency_key) DO NOTHING`.
   - On `SHRED_SUCCESS`, mints and signs Certificate of Erasure (Ed25519).
5. `GET /api/v1/certificates/:requestId`
   - Returns signed CoE payload.

### Idempotency and Legal Fail-Safes

- Equivalent retries with same `idempotencyKey` are accepted as replay-safe.
- Non-equivalent reuse of the same `idempotencyKey` is rejected.
- Chain continuity is enforced: `previousHash` must match the latest ledger hash pointer.
- Outbox payload size is bounded via `MAX_OUTBOX_PAYLOAD_BYTES`.

### Test Guarantees

Current Vitest coverage includes:

- Unit cryptography tests for Ed25519 signing/verification.
- Unit hash determinism tests for token and WORM hash logic.
- End-to-end integration tests for:
  - request -> sync -> ack -> outbox -> certificate happy path
  - strict schema rejection for undeclared fields
  - worker auth failure paths
  - invalid chain / oversized payload rejection
  - idempotent outbox replay handling
  - certificate 404 before shred completion
