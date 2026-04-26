# Project Status

Last updated: 2026-04-26

This file is the current-state implementation ledger. It distinguishes shipped code from future product work so architecture discussions do not drift into aspirational claims.

## Implemented

### Control Plane API

- Bun + Hono HTTP app with standardized JSON errors, request IDs, secure headers, rate limiting, `/health`, `/ready`, and `/metrics`.
- Strict Zod v4 schemas for erasure ingestion, worker auth headers, task acknowledgements, outbox ingestion, admin queries, and client management.
- Metadata-only erasure ingestion that rejects undeclared/raw PII fields.
- Durable `erasure_jobs`, `task_queue`, `audit_ledger`, `certificates`, `clients`, and `usage_events` tables.
- `FOR UPDATE SKIP LOCKED` task leasing with retry counters, exponential backoff, and `DEAD_LETTER` state.
- Worker auth with `x-client-id` and hashed bearer tokens.
- Optional request signing middleware for worker API calls.
- Shadow-mode burn-in gate: live mutation can be blocked until the worker records the required number of shadow successes.
- WORM ledger ingestion with canonical JSON hash chaining and idempotent replay handling.
- Config-hash heartbeat logging from worker `/sync`.
- Ed25519-signed Certificate of Erasure payloads and PDF downloads via `pdf-lib`.
- Admin APIs for usage, clients, key rotation, deactivation, erasure request listing/detail, WORM NDJSON export, and DLQ requeue.
- Durable webhook finalization for terminal outbox events.

### Worker Sidecar

- Bun + TypeScript data-plane worker using `postgres.js` and Web Crypto only.
- Strict `compliance.worker.yml` parser with legal attestation, rule-level legal citations, root PII mapping, satellite targets, blob targets, schema integrity hash, and KMS key-source options.
- Runtime KEK/HMAC resolution from env/file, AWS KMS, GCP Secret Manager, or HashiCorp Vault adapters.
- Signed worker config verification support.
- Schema drift detection and config/schema compatibility checks at boot.
- Root-row `SELECT FOR UPDATE` inside `REPEATABLE READ` before live graph traversal and mutation.
- Recursive FK graph discovery with cycle protection, max-depth breaker, and fail-closed FK cascade/set-null guardrails.
- Evidence-based retention evaluation across configured rule tables.
- AES-256-GCM envelope encryption, HMAC pseudonymization, and explicit `Uint8Array` wipe paths.
- Transactional vaulting, reversible shadow mode, notice reservation, mailer webhook transport, and crypto-shredding.
- Satellite chunking with `FOR UPDATE SKIP LOCKED`, batch limits, and event-loop yielding.
- S3 blob target handling with native SigV4, legal hold support, version-aware purge, and HMACed receipts to the Control Plane.
- Local outbox leasing, exponential backoff, prioritized catch-up for terminal events, and dead-lettering.
- Worker `/healthz`, `/readyz`, and `/metrics`.

### Web Dashboard

- Next.js App Router + React 19 + Tailwind v4 + Auth.js.
- Server-side BFF pattern: admin token is used only on the server.
- Protected `/dashboard/*` routes with email allowlist.
- No manufactured dashboard rows. Missing `ADMIN_API_TOKEN` or Control Plane errors render explicit configuration-required states.
- Overview, erasure request table, erasure request detail, audit ledger, worker client management, and dead-letter recovery pages.
- Server actions for client creation, token rotation, client deactivation, and DLQ requeue.
- PDF certificate links and server-side NDJSON audit export proxy.
- Loading, route error, not-found, empty-state, skeleton, and toast UX.

### Deployment And Operations

- Dockerfiles for API, worker, and web.
- Docker Compose stack for Postgres, API, worker, web, Prometheus, Alertmanager, Grafana, and local mock mail/webhook sink.
- Kubernetes baseline with restricted pod security posture, service accounts, probes, services, network policies, PDBs, and Vault CSI SecretProviderClass.
- Prometheus scrape config, alert rules, Grafana dashboard, and operational runbooks for DLQ, schema drift, audit export, backup/restore, key rotation, and S3 blob erasure.
- Local E2E script for deterministic compose smoke execution.

## Verified Locally

- `bun run api:test`: 30 tests passing.
- `bun run engine:test`: 85 tests passing.
- `bun run typecheck`: API, worker, and web type checks passing.
- `bun run web:build`: production Next.js build passing.

The Playwright web smoke suite is present but requires host browser system libraries. On this workstation Chromium failed to start because `libnspr4.so` was missing.

## Intentionally Deferred

- Hosted billing provider integration.
- Production OAuth/SAML tenant onboarding.
- Real email/SMS vendor integration beyond the worker mailer webhook boundary.
- Managed cloud deployment, TLS certificates, DNS, WAF, external logging, and external immutable archival.
- True long-polling or broker-backed task transport.
- Human legal review of the DPDP/PMLA retention templates.
- SOC 2/ISO 27001 controls, VAPT, and third-party cryptographic review.
