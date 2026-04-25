# Complete Project Guide

This document is the current-state architecture guide for the DPDP/PMLA Compliance Engine in this repository.

It explains:

- what the system does
- why it is split into two planes
- how each lifecycle stage works
- what fail-safes exist today
- what metadata leaves the client boundary and what never does
- how retries, dead letters, WORM logging, and certificates behave

This guide is written against the code that exists now. It does not assume features that are still roadmap items.

## 1. What This Project Is

This project is a zero-trust compliance execution engine for account erasure and legal retention.

At a high level:

- The **Control Plane** accepts erasure requests, manages timing, leases tasks, validates worker receipts, and issues Certificates of Erasure.
- The **Data Plane** runs inside the client environment, mutates the client database locally, vaults PII, sends notices, and eventually crypto-shreds the retained payload.

The system is intentionally split because the platform must **coordinate compliance centrally without ever ingesting raw PII**.

## 2. What It Does In Plain English

When a client asks to erase a user:

1. The API records the legal request and starts a cooldown timer.
2. When due, the worker claims a `VAULT_USER` task.
3. The worker decides whether the user can be deleted immediately or must be retained in encrypted form.
4. If retention is required, the worker encrypts the sensitive payload locally, masks live identifiers, and stores only encrypted data in its local vault.
5. Later, the worker sends the pre-erasure notice.
6. When the retention period ends, the worker destroys the only key that can decrypt the vault payload.
7. The API records the full chain of worker events and signs the final event hash as the legal proof artifact.

## 3. What Exists Today

### 3.1 Control Plane

Implemented:

- Hono-based API
- Zod request validation
- worker authentication via bearer token hash
- worker request signing verification
- erasure job state machine
- task queue with leases, retries, and dead-letter handling
- WORM audit ledger ingestion with replay protection
- Ed25519-signed Certificate of Erasure
- admin endpoints for client lifecycle, dead-letter recovery, usage reporting, and audit export
- webhook dispatch for terminal completion events
- rate limiting and standardized problem-details errors

### 3.2 Data Plane

Implemented:

- signed config verification
- config-to-schema compatibility checks
- schema drift detection
- recursive graph traversal
- atomic vaulting in `REPEATABLE READ`
- local AES-256-GCM vaulting
- HMAC-SHA256 pseudonymization
- notification leasing and local mail transport
- crypto-shredding
- transactional outbox with lease, retry, and dead-letter handling
- worker health, readiness, and metrics endpoints

### 3.3 Ops Surface

Implemented in repo:

- Dockerfiles for API and worker
- local Docker Compose stack
- Prometheus and Grafana local deployment
- Kubernetes manifests and runbooks

Not implemented as first-party product:

- React/Next.js user-facing platform UI
- mTLS worker-to-control-plane transport
- external KMS/Vault integration as running code inside this repository

## 4. Trust Model

The system boundary is not “zero egress.” It is **zero raw-PII egress**.

What never leaves the client boundary:

- decrypted PII
- vaulted ciphertext plaintext form
- live database rows
- DEKs and KEKs

What does leave the client boundary:

- opaque identifiers
- request ids
- event types
- timestamps
- legal metadata
- hashes
- WORM chain fields
- certificate payloads and signatures

## 5. Visual Companion

All diagrams are stored in [project-visual](./project-visual/README.md).

- [System Context](./visuals/01-system-context.md)
- [End-To-End Sequence](./visuals/02-end-to-end-sequence.md)
- [Control Plane State Machine](./visuals/03-control-plane-state-machine.md)
- [Worker Execution Branches](./visuals/04-worker-execution-branches.md)
- [Fail-Safe And Retry Flows](./visuals/05-fail-safe-retry-flows.md)

## 6. Major Components

### 6.1 Control Plane API

Primary responsibility:

- accept and normalize legal erasure requests
- hold the lifecycle calendar
- lease worker tasks safely
- validate worker receipts
- preserve an immutable audit trail
- issue a signed Certificate of Erasure

Key storage objects:

- `clients`
- `erasure_jobs`
- `task_queue`
- `audit_ledger`
- `certificates`
- `usage_events`

### 6.2 Worker Sidecar

Primary responsibility:

- mutate the client database locally
- discover dependencies
- evaluate retention rules
- vault PII locally
- pseudonymize live references
- dispatch the pre-erasure notice
- destroy the retained key material when shredding is legally due

Key storage objects:

- `pii_vault`
- `user_keys`
- `outbox`

## 7. Cryptographic Model

### 7.1 Vaulting

The worker uses:

- **AES-256-GCM** to encrypt local PII payloads
- a per-subject **DEK**
- a RAM-resident **KEK** to wrap the DEK

The encrypted payload is stored in `pii_vault`.
The wrapped DEK is stored in `user_keys`.

### 7.2 Pseudonymization

The worker uses **HMAC-SHA256** to derive:

- stable user hash identifiers
- pseudonyms
- masked replacements where configured

This preserves referential usefulness without preserving raw identity.

### 7.3 WORM Logging

Every worker event entering the local outbox computes:

`current_hash = SHA-256(previous_hash + canonical_JSON(payload) + idempotency_key)`

This creates an append-only tamper-evident chain that the API preserves in `audit_ledger`.

### 7.4 Certification

When the lifecycle reaches a terminal worker event:

- `SHRED_SUCCESS`
- `USER_HARD_DELETED`

the API signs the final WORM hash with **Ed25519** and stores the resulting Certificate of Erasure.

## 8. Request Lifecycle

### 8.1 Ingestion

The request enters through `POST /api/v1/erasure-requests`.

Required fields include:

- `subject_opaque_id`
- `idempotency_key`
- `trigger_source`
- `actor_opaque_id`
- `legal_framework`
- `request_timestamp`

Important boundary rules:

- raw emails and phone numbers are rejected at the API boundary
- payload is strict and unknown keys are rejected
- unsafe webhook URLs are rejected

Outcome:

- the API inserts a row into `erasure_jobs`
- the API inserts the first `VAULT_USER` row into `task_queue`
- the job starts in `WAITING_COOLDOWN`

### 8.2 Cooldown

The API computes `vault_due_at` in Postgres using interval math.

Nothing in the worker tracks the calendar.
This is deliberate. If a worker crashes or is redeployed, the schedule still exists centrally.

### 8.3 Task Leasing

The worker polls `GET /api/v1/worker/sync` in a bounded short-poll loop.

The API:

- materializes due `NOTIFY_USER` and `SHRED_USER` tasks lazily
- claims the next task using `FOR UPDATE SKIP LOCKED`
- marks it `DISPATCHED`
- sets a lease expiry

This prevents multiple workers from executing the same task concurrently.

## 9. Worker Lifecycle Branches

### 9.1 `VAULT_USER`

This is the most important mutation stage.

The worker:

1. opens a `REPEATABLE READ` transaction
2. sets `SET LOCAL lock_timeout = '5s'`
3. locks the root row with `SELECT ... FOR UPDATE`
4. discovers dependencies using the recursive graph query
5. evaluates retention rules against configured evidence tables
6. branches by dependency count

#### Branch A: direct hard delete

If the dependency count is `0`:

- the worker deletes the root row directly
- no `pii_vault` row is created
- the worker emits `USER_HARD_DELETED`
- the API immediately finalizes the lifecycle and can mint the certificate

#### Branch B: retained vault path

If the dependency count is greater than `0`:

- the worker collects the configured root PII columns
- generates a DEK
- encrypts the PII payload
- wraps the DEK
- inserts `pii_vault`
- inserts `user_keys`
- mutates live columns using configured rules:
  - `HMAC`
  - `STATIC_MASK`
  - `NULLIFY`
- applies configured satellite redactions or hard deletes
- applies configured S3 blob protections:
  - parses declared object URL columns only
  - stores raw Bucket/Key/VersionID in the worker-local `blob_objects` table
  - applies S3 Object Lock Legal Hold in live mode
  - optionally overwrites the object with a non-PII placeholder
  - masks the live URL column with an HMAC value
- emits `USER_VAULTED`

#### Retention result

The worker calculates:

- `retention_years`
- `applied_rule_name`
- `notification_due_at`
- `retention_expiry`

The API persists those timestamps and uses them later to materialize the next lifecycle tasks.

### 9.2 `NOTIFY_USER`

The worker only sends notice from the local vault.

Flow:

1. load vault record
2. reserve a short lease on the vault row
3. reject if notice already sent
4. reject if current time is not yet due
5. reject if current time is already past retention expiry
6. unwrap DEK
7. decrypt vault payload in RAM only
8. resolve recipient columns from explicit config
9. send the local mail request with a deterministic idempotency key
10. mark `notification_sent_at`
11. append `NOTIFICATION_SENT` to outbox
12. zero buffers in `finally`

### 9.3 `SHRED_USER`

This is the irreversible end of the retained path.

Flow:

1. lock vault row in `REPEATABLE READ`
2. refuse shredding before `retention_expiry`
3. refuse shredding if notice is required but missing
4. delete the DEK from `user_keys`
5. purge configured S3 blob objects according to their declared action
6. replace `encrypted_pii` with a destroyed sentinel
7. set `shredded_at`
8. append `SHRED_SUCCESS`

After this point, the ciphertext is no longer decryptable because the key is gone.

Blob receipts in `SHRED_SUCCESS` contain only HMACed object references, HMACed version identifiers, version counts, and purge status. Raw S3 bucket names, keys, URLs, and object bytes never leave the client VPC because object keys can themselves contain PII.

## 10. Control Plane State Machine

### 10.1 Job states

`erasure_jobs.status` transitions:

- `WAITING_COOLDOWN`
- `EXECUTING`
- `VAULTED`
- `NOTICE_SENT`
- `SHREDDED`
- `FAILED`
- `CANCELLED`

Transitions:

- `WAITING_COOLDOWN -> CANCELLED` if cancelled before execution
- `WAITING_COOLDOWN -> EXECUTING` when `VAULT_USER` is leased
- `EXECUTING -> VAULTED` on `USER_VAULTED`
- `EXECUTING -> SHREDDED` on `USER_HARD_DELETED`
- `VAULTED -> NOTICE_SENT` on `NOTIFICATION_SENT`
- `NOTICE_SENT -> SHREDDED` on `SHRED_SUCCESS`
- any active stage can move to `FAILED` through task DLQ exhaustion

### 10.2 Task states

`task_queue.status` transitions:

- `QUEUED`
- `DISPATCHED`
- `COMPLETED`
- `DEAD_LETTER`

Retry behavior:

- retryable failure: task returns to `QUEUED` with exponential backoff
- non-retryable failure: task moves to `DEAD_LETTER`
- attempt ceiling reached: task moves to `DEAD_LETTER`

### 10.3 Outbox states

`outbox.status` transitions:

- `pending`
- `leased`
- `processed`
- `dead_letter`

The outbox uses its own lease and retry state machine so network delivery never holds a long transaction open.

## 11. Fail-Safes

### 11.1 Boundary fail-safes

- zero-PII ingestion schema
- strict Zod validation
- idempotency conflict detection
- standardized JSON problem responses
- worker auth checks
- signed worker request verification

### 11.2 Worker boot fail-safes

- signed config verification
- secret decoding and entropy validation
- schema drift detection
- config-to-schema compatibility check
- fatal startup refusal if invariants are broken

### 11.3 Database correctness fail-safes

- `REPEATABLE READ` for mutation transactions
- root row `FOR UPDATE` lock before graph traversal
- `lock_timeout = '5s'`
- `FOR UPDATE SKIP LOCKED` for task and outbox leasing
- chunked satellite mutations to avoid broad lock starvation

### 11.4 Cryptographic fail-safes

- Web Crypto only
- GCM auth-tag integrity
- DEK and plaintext buffer wiping
- deterministic hash chaining
- Ed25519 final certificate signing

### 11.5 Retry and recovery fail-safes

- task retries with backoff
- task DLQ after exhaustion
- outbox retries with backoff
- outbox dead-letter after exhaustion
- replay-safe worker event ingestion
- replay-safe certificate creation
- replay-safe terminal webhook retries

### 11.6 Legal and lifecycle fail-safes

- out-of-order worker events are rejected
- worker outbox legal metadata must match original immutable request
- notice cannot be sent after expiry
- shred cannot happen before retention expiry
- shred requires notice by default
- cancellation only works before execution starts

### 11.7 Network fail-safes

- redirect following disabled on external dispatches
- webhook SSRF guardrails
- mailer timeout
- control-plane timeout

## 12. Why The Design Is Safe

This system is defensible because:

- the API cannot leak raw user data it never receives
- the worker never mutates and externally notifies in one fragile network-dependent step
- long-running network operations are decoupled through the outbox
- retries do not duplicate legal state because every major step is idempotent
- the terminal artifact is bound to the final WORM hash, not to a mutable log message

## 13. Operational Surface

### 13.1 Health and metrics

API:

- `/health`
- `/ready`
- `/metrics`

Worker:

- `/healthz`
- `/readyz`
- `/metrics`

Current worker metrics:

- `dpdp_outbox_queue_depth`
- `dpdp_dead_letters_total`

### 13.2 Local deployment

The repository includes a local Docker Compose stack for:

- Postgres
- API
- worker
- mock gateway
- Prometheus
- Alertmanager
- Grafana

### 13.3 Runbooks

Existing runbooks:

- [audit export](./runbooks/audit-export.md)
- [backup / restore](./runbooks/backup-restore.md)
- [dead-letter recovery](./runbooks/dead-letter-recovery.md)
- [key rotation](./runbooks/key-rotation.md)
- [schema drift](./runbooks/schema-drift.md)

## 14. Important Current Constraints

These are important so future readers do not confuse the current implementation with roadmap ambitions.

Not currently implemented as runtime behavior:

- mTLS between worker and API
- a first-party product dashboard application
- external KMS/Vault as a running dependency inside this repo
- DNS rebinding-resistant live webhook resolution

What exists instead:

- bearer auth plus request signing between worker and API
- Ed25519 signing inside the API process
- local Prometheus/Grafana ops stack
- hard webhook URL validation and redirect denial

## 15. Where To Read Next In Code

Control plane:

- [api/src/app.ts](../api/src/app.ts)
- [api/src/modules/control-plane/router.ts](../api/src/modules/control-plane/router.ts)
- [api/src/modules/control-plane/service/index.ts](../api/src/modules/control-plane/service/index.ts)
- [api/src/modules/control-plane/service/guards.ts](../api/src/modules/control-plane/service/guards.ts)
- [api/src/modules/control-plane/service/terminal.ts](../api/src/modules/control-plane/service/terminal.ts)
- [api/src/modules/control-plane/repository/index.ts](../api/src/modules/control-plane/repository/index.ts)

Worker:

- [compliance-engine/src/index.ts](../compliance-engine/src/index.ts)
- [compliance-engine/src/worker.ts](../compliance-engine/src/worker.ts)
- [compliance-engine/src/engine/vault.execution.ts](../compliance-engine/src/engine/vault.execution.ts)
- [compliance-engine/src/engine/notifier.ts](../compliance-engine/src/engine/notifier.ts)
- [compliance-engine/src/engine/shredder.ts](../compliance-engine/src/engine/shredder.ts)
- [compliance-engine/src/network/outbox.ts](../compliance-engine/src/network/outbox.ts)

## 16. Summary

This project is a zero-trust, two-plane compliance engine with a strict separation of concerns:

- the API owns time, orchestration, validation, certification, and audit state
- the worker owns local mutation, local encryption, local notices, and local shredding

Its main safety properties come from:

- keeping raw PII local
- performing live mutation atomically
- preserving a replay-safe WORM chain
- delaying irreversible destruction until legal conditions are satisfied
- signing the final lifecycle hash as proof

That is the core of what this system does and how it stays safe while doing it.
