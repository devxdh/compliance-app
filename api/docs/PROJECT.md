## Control Plane Bootstrap Scope

This document captures the immediate bootstrap implemented in `api/src` for the Central API (Control Plane).

### Architectural Position

- The API is a **Zero-PII Orchestrator**.
- Raw PII never enters the API boundary.
- Worker communication is metadata-only and state-machine driven.

### Implemented Responsibilities

1. Erasure request intake and durable orchestration records.
2. Worker task leasing (`sync`) and acknowledgment (`ack`) endpoints.
3. Worker outbox ingestion for lifecycle state transitions.
4. Certificate of Erasure minting on `SHRED_SUCCESS`.
5. Ed25519 signatures via native Web Crypto (`globalThis.crypto`), no `node:crypto`.

### Storage Model (Schema)

- `erasure_requests`
- `worker_tasks`
- `worker_outbox_events`
- `certificates`

All tables are provisioned by `src/db/migrations.ts` using `postgres.js`, no ORM.

### API Stack

- Hono
- Zod
- @hono/zod-validator
- postgres.js
- Vitest (unit + integration)

### Test Strategy

- Unit:
  - CoE signing and signature verification.
- Integration:
  - request creation -> worker sync -> task ack -> outbox ingestion -> CoE retrieval.
  - strict-body validation to enforce Zero-PII boundary.
