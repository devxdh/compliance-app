# `ARCHITECTURE.md`
## DPDP Compliance Engine: Master System Architecture

### 1. System Overview & Directives
This project is an enterprise-grade DPDP/PMLA Compliance Engine with GDPR-compatible primitives where clients require them. It operates on a **Zero-Trust Sidecar Model** divided into two isolated planes:
1. **The Control Plane (Central API):** A central orchestrator that manages timelines, queues tasks, and stores cryptographic receipts. It **never** ingests or touches raw PII.
2. **The Data Plane (Worker Sidecar):** A local service running inside the client's VPC. It mutates data, encrypts PII, and generates cryptographic WORM logs. It has Egress-only network access to poll the Control Plane.

**Strict Technical Constraints (NO EXCEPTIONS):**
* **Runtime:** Bun (Legacy Node.js APIs must be avoided where Bun native APIs exist).
* **Cryptography:** Native `globalThis.crypto` (Web Crypto API) ONLY. Do not import `node:crypto`.
* **Database Driver:** `postgres.js` ONLY. Do not use ORMs (Prisma, TypeORM, Sequelize).
* **API Framework:** Hono.js with `@hono/zod-validator`.
* **PDF Generation:** `pdf-lib` (pure JS).
* **Web Dashboard:** Next.js App Router + Auth.js BFF. Browser code never receives Control Plane admin tokens.

---

### 2. Cryptographic Standards
All operations must adhere to these mathematical primitives:
* **Envelope Encryption:** A 256-bit AES Master Key (`KEK`) lives strictly in RAM. It wraps 32-byte Data Encrypting Keys (`DEK`) generated uniquely per subject.
* **Encryption Algorithm:** AES-256-GCM (Requires a 12-byte IV and appends a 16-byte Auth Tag).
* **Pseudonymization:** HMAC-SHA256. Used for public identifiers and S3 object reference receipts.
* **Tamper-Evident WORM Logging:** Hash Chaining. $Hash_n = \text{SHA256}(Hash_{n-1} + \text{canonical\_JSON}(\text{Payload}) + \text{idempotency\_key})$.
* **Legal Certification:** Ed25519 digital signatures are used to sign Certificate of Erasure payloads and PDFs.

---

### 3. The Configuration Contract (`compliance.worker.yml`)
**The Zero-Guessing Policy:** The worker must never guess which columns contain PII. The client is legally responsible for explicitly defining every target.

* **Legal Attestation:** Mandatory DPO identifier and acknowledgment of legal review required for boot.
* **Statutory Citations:** Every retention rule must link to a specific law (e.g., "PMLA Sec 12").
* **Secret Resolution:** Master keys can be resolved via `aws_kms`, `gcp_secret_manager`, `hashicorp_vault`, env vars, or file-mounted secrets.
* **Config Drift Audit:** The worker sends the active YAML SHA-256 hash, config version, and DPO identifier during `/worker/sync`; the Control Plane records newly observed hashes in the WORM audit surface.

---

### 4. Database Topologies

#### A. Control Plane (Central API)
* `clients`: `(id UUID PK, name TEXT, worker_api_key_hash TEXT, is_active BOOLEAN, shadow_success_count INT, live_mutation_enabled BOOLEAN)`
* `erasure_jobs`: `(id UUID PK, client_id UUID, idempotency_key UUID UNIQUE, subject_opaque_id TEXT, trigger_source TEXT, legal_framework TEXT, actor_opaque_id TEXT, applied_rule_name TEXT, applied_rule_citation TEXT, status TEXT, vault_due_at TIMESTAMPTZ, notification_due_at TIMESTAMPTZ, shred_due_at TIMESTAMPTZ)`
* `task_queue`: `(id UUID PK, erasure_job_id UUID, task_type TEXT, status TEXT, attempt_count INT, next_attempt_at TIMESTAMPTZ, dead_lettered_at TIMESTAMPTZ)`
* `audit_ledger`: `(ledger_seq BIGSERIAL, client_id UUID, worker_idempotency_key TEXT UNIQUE, event_type TEXT, previous_hash TEXT, current_hash TEXT)`
* `certificates`: `(request_id UUID PK, subject_opaque_id TEXT, method TEXT, legal_framework TEXT, shredded_at TIMESTAMPTZ, signature_base64 TEXT, public_key_spki_base64 TEXT)`
* `usage_events`: `(id UUID PK, billing_key TEXT UNIQUE, client_id UUID, erasure_job_id UUID, event_type TEXT, units INT, occurred_at TIMESTAMPTZ)`

#### B. Data Plane (Worker Target)
* `pii_vault`: `(user_uuid_hash TEXT PK, encrypted_pii JSONB, retention_expiry TIMESTAMPTZ, notification_due_at TIMESTAMPTZ, notification_sent_at TIMESTAMPTZ NULL, trigger_source TEXT, legal_framework TEXT, actor_opaque_id TEXT, applied_rule_name TEXT, applied_rule_citation TEXT)`
* `user_keys`: `(user_uuid_hash TEXT PK REFERENCES pii_vault, encrypted_dek BYTEA)`
* `blob_objects`: `(id UUID PK, user_uuid_hash TEXT, provider TEXT, bucket TEXT, object_key TEXT, version_id TEXT, action TEXT, legal_hold_status TEXT, shred_status TEXT)`
* `outbox`: `(id UUID PK, idempotency_key TEXT UNIQUE, status TEXT, previous_hash TEXT, current_hash TEXT)`

---

### 5. Component 1: The Control Plane (Hono API)

#### 5.1. Authorization
* **Immutable Identity:** Workers authenticate using a UUID `x-client-id` and a hashed Bearer token.
* **Burn-in Gate:** New workers are restricted to `shadow_mode: true` until 100 successful shadow tasks are acknowledged.
* **Admin Boundary:** Admin endpoints require `Authorization: Bearer <ADMIN_API_TOKEN>`. The web app calls these endpoints only from server components/actions.

#### 5.2. Legal Artifacts
* **Ed25519 Signing:** The API mints a digital signature over the final ledger hash.
* **PDF Generator:** Transforms technical WORM metadata into a high-contrast, professional PDF suitable for legal audits.
* **Task Materializer:** The API owns the calendar. It creates `NOTIFY_USER` and `SHRED_USER` tasks from worker-reported `notification_due_at` and `shred_due_at`.
* **Webhook Delivery:** Terminal events enqueue durable webhook delivery attempts; equivalent outbox replays retry webhook finalization instead of dropping the callback.

---

### 6. Component 2: The Data Plane (Worker Sidecar)

#### 6.1. S3 Blob Lifecycle
* **Discovery:** Parses configured S3 URLs from DB columns.
* **Protection:** Applies S3 Object Lock (Legal Hold) during vaulting to protect against premature erasure.
* **Hard Purge:** On shredding, the worker enumerates all versions via `ListObjectVersions` and deletes every entry, including delete markers, satisfying DPDP's permanent erasure mandate.

#### 6.2. Native KMS Providers
* **Zero SDKs:** Implements AWS SigV4, GCP OAuth, and Vault REST protocols directly via `fetch` to maintain a tiny, auditable attack surface.

#### 6.3. Execution Safety
* **TOCTOU Lock:** Live vaulting locks the root row on the primary database before graph traversal and retention evaluation.
* **Replica Routing:** Replica reads are allowed for dry-run/shadow reads only. Live mutations prioritize consistency over offloading.
* **Lock Timeout:** Critical repeatable-read transactions set a local `lock_timeout` to fail closed instead of hanging indefinitely.
* **Memory Hygiene:** DEKs and plaintext `Uint8Array` buffers are wiped with `.fill(0)` in `finally` blocks.
* **Satellite Chunking:** Unlinked satellite tables are processed in cursor batches with `FOR UPDATE SKIP LOCKED` and event-loop yielding.

### 7. Component 3: Operator Web Dashboard

The web package is a server-side BFF:

* Auth.js protects `/dashboard/*` and restricts operators by email allowlist.
* All Control Plane calls are made from React Server Components, route handlers, or server actions.
* Missing `ADMIN_API_TOKEN` displays a configuration-required state instead of mock data.
* Dashboard pages cover overview, erasure requests, job detail, WORM audit ledger export, worker clients, and dead-letter recovery.
* Certificate downloads use the API's signed PDF route.

### 8. Polling Contract

The repository intentionally uses bounded 5-second short-polling rather than held long-poll HTTP requests. This avoids extra LISTEN/NOTIFY or broker infrastructure while preserving egress-only worker networking. If true long-polling is required later, it should be implemented as a Control Plane transport upgrade without changing task semantics.

---
**END OF SPECIFICATION**
