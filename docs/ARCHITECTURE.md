# `ARCHITECTURE.md`
## DPDP Compliance Engine: Master System Architecture

### 1. System Overview & Directives
This project is an enterprise-grade Data Protection (DPDP/GDPR) Compliance Engine. It operates on a **Zero-Trust Sidecar Model** divided into two isolated planes:
1. **The Control Plane (Central API):** A central orchestrator that manages timelines, queues tasks, and stores cryptographic receipts. It **never** ingests or touches raw PII.
2. **The Data Plane (Worker Sidecar):** A local service running inside the client's VPC. It mutates data, encrypts PII, and generates cryptographic WORM logs. It has Egress-only network access to poll the Control Plane.

**Strict Technical Constraints (NO EXCEPTIONS):**
* **Runtime:** Bun (Legacy Node.js APIs must be avoided where Bun native APIs exist).
* **Cryptography:** Native `globalThis.crypto` (Web Crypto API) ONLY. Do not import `node:crypto`.
* **Database Driver:** `postgres.js` ONLY. Do not use ORMs (Prisma, TypeORM, Sequelize).
* **API Framework:** Hono.js with `@hono/zod-validator`.
* **PDF Generation:** `pdf-lib` (Pure JS / Zero-Dependency).

---

### 2. Cryptographic Standards
All operations must adhere to these mathematical primitives:
* **Envelope Encryption:** A 256-bit AES Master Key (`KEK`) lives strictly in RAM. It wraps 32-byte Data Encrypting Keys (`DEK`) generated uniquely per user.
* **Encryption Algorithm:** AES-256-GCM (Requires a 12-byte IV and appends a 16-byte Auth Tag).
* **Pseudonymization:** HMAC-SHA256. Used for public identifiers and S3 object reference receipts.
* **Tamper-Evident WORM Logging:** Hash Chaining. $Hash_n = \text{SHA256}(Hash_{n-1} + \text{canonical\_JSON}(\text{Payload}) + \text{idempotency\_key})$.
* **Legal Certification:** Ed25519 Digital Signatures used to sign PDF "Certificates of Erasure."

---

### 3. The Configuration Contract (`compliance.worker.yml`)
**The Zero-Guessing Policy:** The worker must never guess which columns contain PII. The client is legally responsible for explicitly defining every target.

* **Legal Attestation:** Mandatory DPO identifier and acknowledgment of legal review required for boot.
* **Statutory Citations:** Every retention rule must link to a specific law (e.g., "PMLA Sec 12").
* **Secret Resolution:** Master keys can be resolved via `aws_kms`, `gcp_secret_manager`, or `hashicorp_vault` native providers.

---

### 4. Database Topologies

#### A. Control Plane (Central API)
* `clients`: `(id UUID PK, name TEXT, worker_api_key_hash TEXT, is_active BOOLEAN, shadow_success_count INT, live_mutation_enabled BOOLEAN)`
* `erasure_jobs`: `(id UUID PK, client_id UUID, idempotency_key UUID, subject_opaque_id TEXT, trigger_source TEXT, legal_framework TEXT, applied_rule_citation TEXT, status TEXT)`
* `task_queue`: `(id UUID PK, erasure_job_id UUID, task_type TEXT, status TEXT, attempt_count INT, next_attempt_at TIMESTAMPTZ)`
* `audit_ledger`: `(ledger_seq BIGSERIAL, client_id UUID, worker_idempotency_key TEXT UNIQUE, event_type TEXT, previous_hash TEXT, current_hash TEXT)`
* `certificates`: `(request_id UUID PK, subject_opaque_id TEXT, method TEXT, legal_framework TEXT, shredded_at TIMESTAMPTZ, signature_base64 TEXT, public_key_spki_base64 TEXT)`

#### B. Data Plane (Worker Target)
* `pii_vault`: `(user_uuid_hash TEXT PK, encrypted_pii JSONB, retention_expiry TIMESTAMPTZ, notification_due_at TIMESTAMPTZ, notification_sent_at TIMESTAMPTZ NULL)`
* `user_keys`: `(user_uuid_hash TEXT PK REFERENCES pii_vault, encrypted_dek BYTEA)`
* `blob_objects`: `(id UUID PK, user_uuid_hash TEXT, provider TEXT, bucket TEXT, object_key TEXT, version_id TEXT, action TEXT, legal_hold_status TEXT, shred_status TEXT)`
* `outbox`: `(id UUID PK, idempotency_key TEXT UNIQUE, status TEXT, previous_hash TEXT, current_hash TEXT)`

---

### 5. Component 1: The Control Plane (Hono API)

#### 5.1. Authorization
* **Immutable Identity:** Workers authenticate using a UUID `x-client-id` and a hashed Bearer token.
* **Burn-in Gate:** New workers are restricted to `shadow_mode: true` until 100 successful shadow tasks are acknowledged.

#### 5.2. Legal Artifacts
* **Ed25519 Signing:** The API mints a digital signature over the final ledger hash.
* **PDF Generator:** Transforms technical WORM metadata into a high-contrast, professional PDF suitable for legal audits.

---

### 6. Component 2: The Data Plane (Worker Sidecar)

#### 6.1. S3 Blob Lifecycle
* **Discovery:** Parses configured S3 URLs from DB columns.
* **Protection:** Applies S3 Object Lock (Legal Hold) during vaulting to protect against premature erasure.
* **Hard Purge:** On shredding, the worker enumerates all versions via `ListObjectVersions` and deletes every entry, including delete markers, satisfying DPDP's permanent erasure mandate.

#### 6.2. Native KMS Providers
* **Zero SDKs:** Implements AWS SigV4, GCP OAuth, and Vault REST protocols directly via `fetch` to maintain a tiny, auditable attack surface.

---
**END OF SPECIFICATION**
