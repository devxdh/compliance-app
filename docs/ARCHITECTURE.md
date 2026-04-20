This is the ultimate **Master System Architecture Document (MSAD)**. I have synthesized every architectural decision, strict constraint, and clinical mechanism we have discussed. 

Per your instructions, all observability, metrics, and logging features have been stripped out to keep the focus purely on the core operational engines. 

Save this entire block as **`ARCHITECTURE.md`**. When you hand this to Codex, your prompt should simply be: *"Read `ARCHITECTURE.md` completely. Acknowledge the architecture, the Zero-Trust constraints, the Zero-Guessing policy, and the Bun/Hono stack. Do not write any code until I give a Phase 1 command."*

***

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
* **API Framework:** Hono.js with `@hono/zod-validator`. Do not use Express.
* **Typings:** Strict TypeScript. No `any` types.

---

### 2. Cryptographic Standards
All operations must adhere to these mathematical primitives:
* **Envelope Encryption:** A 256-bit AES Master Key (`KEK`) lives strictly in RAM. It wraps 32-byte Data Encrypting Keys (`DEK`) generated uniquely per user.
* **Encryption Algorithm:** AES-256-GCM (Requires a 12-byte IV and appends a 16-byte Auth Tag for integrity).
* **Pseudonymization:** HMAC-SHA256. Used to mask public identifiers (e.g., emails) so relational constraints survive without exposing identity.
* **Tamper-Evident WORM Logging:** The Outbox uses Hash Chaining. $Hash_n = \text{SHA256}(Hash_{n-1} + \text{canonical\_JSON}(\text{Payload}) + \text{idempotency\_key})$.
* **Legal Certification:** Ed25519 Digital Signatures used by the API to sign "Certificates of Erasure."

---

### 3. The Configuration Contract (`compliance.worker.yml`)
**The Zero-Guessing Policy:** The worker must never guess which columns contain PII. The client is legally responsible for explicitly defining every PII column and unlinked table. If a value is missing or `null`, the worker must fail-fast and refuse to boot.

```yaml
version: "1.0"
database:
  app_schema: null             # REQUIRED: e.g., "public"
  engine_schema: "dpdp_engine" # Default provisioning schema

compliance_policy:
  retention_years: null        # REQUIRED: e.g., 5
  notice_window_hours: null    # REQUIRED: e.g., 48

graph:
  root_table: "users"
  root_id_column: "id"
  max_depth: 32
  root_pii_columns:            # REQUIRED: Explicit column mapping
    email: "HMAC"
    full_name: "STATIC_MASK"
    date_of_birth: "NULLIFY"

satellite_targets:             # REQUIRED: Explicit unlinked tables
  - table: "marketing_leads"
    lookup_column: "email"
    action: "redact"
    masking_rules:
      name: "STATIC_MASK"
      phone_number: "HMAC"
      email: "HMAC"
  - table: "system_audit_logs"
    lookup_column: "user_identifier"
    action: "hard_delete"

outbox:
  batch_size: 10
  lease_seconds: 60
  max_attempts: 10

security:
  master_key_env: "DPDP_MASTER_KEY" 
  hmac_key_env: "DPDP_HMAC_KEY"     
```

---

### 4. Database Topologies
Code generation must map exactly to these structures.

#### A. Control Plane (Central API)
* `clients`: `(id UUID PK, name TEXT, worker_api_key_hash TEXT)`
* `erasure_jobs`: `(id UUID PK, client_id UUID, idempotency_key UUID, subject_opaque_id TEXT, trigger_source TEXT, actor_opaque_id TEXT, legal_framework TEXT, request_timestamp TIMESTAMPTZ, tenant_id TEXT NULL, cooldown_days INT, shadow_mode BOOLEAN, webhook_url TEXT NULL, status TEXT, vault_due_at TIMESTAMPTZ, notification_due_at TIMESTAMPTZ NULL, shred_due_at TIMESTAMPTZ NULL, shredded_at TIMESTAMPTZ NULL)`
* `task_queue`: `(id UUID PK, client_id UUID, erasure_job_id UUID, task_type TEXT, payload JSONB, status TEXT DEFAULT 'QUEUED', attempt_count INT, next_attempt_at TIMESTAMPTZ, dead_lettered_at TIMESTAMPTZ NULL)`
* `audit_ledger`: `(id UUID PK, client_id UUID, worker_idempotency_key TEXT UNIQUE, event_type TEXT, payload JSONB, current_hash TEXT)`

#### B. Data Plane (Client DB / Worker Target)
* `pii_vault`: `(user_uuid_hash TEXT PK, root_schema TEXT, root_table TEXT, root_id TEXT, pseudonym TEXT, encrypted_pii JSONB, salt TEXT, dependency_count INT, retention_expiry TIMESTAMPTZ)`
* `user_keys`: `(user_uuid_hash TEXT PK REFERENCES pii_vault ON DELETE CASCADE, encrypted_dek TEXT)`
* `outbox`: `(id UUID PK, idempotency_key TEXT UNIQUE, user_uuid_hash TEXT, event_type TEXT, payload JSONB, previous_hash TEXT, current_hash TEXT)`

---

### 5. Component 1: The Control Plane (Hono API)

The API is purely a state coordinator. It provides three core endpoints protected by Zod schemas.

#### 5.1. Boundary Validation (Zod)
* `SyncHeaderSchema`: Requires `x-client-id` and Auth token.
* `AckPayloadSchema`: `{ status: z.enum(["completed", "failed"]), result: z.record(z.any()) }`.
* `OutboxPayloadSchema`: Strict validation of `idempotency_key`, `user_uuid_hash`, `event_type`, `payload`, `previous_hash`, and `current_hash`. JSON payload size capped to prevent OOM DOS.

#### 5.2. Core Endpoints
1. **`GET /api/v1/worker/sync`**
   * **Mechanism:** The Worker calls this endpoint in a bounded 5-second short-poll loop. Before leasing, the Control Plane materializes any due `NOTIFY_USER` or `SHRED_USER` tasks from `erasure_jobs.notification_due_at` / `erasure_jobs.shred_due_at`, then queries `task_queue` for the oldest due task.
   * **Caveat/Rule:** MUST use `FOR UPDATE SKIP LOCKED` to prevent race conditions across a fleet of workers. Updates status to 'DISPATCHED'.
2. **`POST /api/v1/worker/tasks/:taskId/ack`**
   * **Mechanism:** Updates `task_queue` to 'COMPLETED' or 'FAILED' and advances the state of `erasure_jobs`.
3. **`POST /api/v1/worker/outbox`**
   * **Mechanism:** Ingests the WORM log into `audit_ledger`.
   * **Caveat/Rule:** MUST use `ON CONFLICT (worker_idempotency_key) DO NOTHING` to guarantee idempotency if a worker's network drops and it retries the webhook.
   * **Zero-Trust Guardrail:** The Control Plane MUST verify that `trigger_source`, `actor_opaque_id`, and `legal_framework` still match the immutable ingestion request, and MUST reject out-of-order worker events that skip lifecycle stages.
   * **Legal Certification:** If `event_type === 'SHRED_SUCCESS'`, it triggers `mintCertificateOfErasure()`, utilizing Web Crypto `Ed25519` to digitally sign the payload and save it as mathematical proof of compliance.

#### 5.3. Webhook Egress Guardrails
* `webhook_url` is treated as untrusted input even though it is client-supplied.
* The Control Plane accepts only externally routable `https://` webhook URLs, rejects embedded credentials, rejects loopback/private/special-use literal IP targets, and disables redirect following during delivery to reduce SSRF blast radius.

---

### 6. Component 2: The Data Plane (Worker Sidecar)

The worker executes physical data mutations. It operates in a continuous 5-second short-poll loop against the Control Plane.

#### 6.1. Boot Sequence & Liability Firewall
* Parses `compliance.worker.yml`. Validates KEK entropy (must be exactly 32 bytes).
* **Schema Drift Detection:** Hashes `information_schema.columns` for the target application schema. If the database schema has changed without the YAML being updated, it throws a fatal error and `exit(1)`.

#### 6.2. Graph Traversal & Replica Routing
* Uses a Recursive CTE to traverse the $O(V+E)$ foreign-key graph rooted at the target user.
* **Caveat/Rule:** Requires a circuit breaker (`max_depth: 32`) to prevent $O(\infty)$ cyclic database loops.
* **Scale Engine:** Accepts an optional `DATABASE_URL_REPLICA`. If provided, the massive read-heavy graph calculation must route to the replica, while targeted mutations go to the primary.

#### 6.3. The Vaulting Engine (Atomic Mutation)
All vaulting logic occurs within a `BEGIN ISOLATION LEVEL REPEATABLE READ` block.
* **TOCTOU Fix (Critical):** The worker MUST execute `SELECT ... FOR UPDATE` on the root user row *first*, establishing the snapshot lock, *before* executing the graph traversal.
* **Dynamic Masking:** Reads `graph.root_pii_columns`. Dynamically generates the `UPDATE` SQL using `postgres.js` tagged templates (`STATIC_MASK` $\to$ '[REDACTED]', `HMAC` $\to$ hash, `NULLIFY` $\to$ NULL).
* **Satellite Chunking (Deadlock Mitigation):** For unlinked tables, it MUST NOT run a blanket update. It uses Cursor-Based Batching: `WITH batch AS (SELECT id ... LIMIT 1000 FOR UPDATE SKIP LOCKED) UPDATE ...`.
* **Shadow Mode:** If requested via the payload, the worker executes all cryptography and logic, but explicitly calls `tx.rollback()` at the end, throwing a custom `ShadowModeRollback` to safely benchmark production loads without altering data.

#### 6.4. Egress Outbox Loop
* A background async loop queries the local `outbox` table using `FOR UPDATE SKIP LOCKED`.
* Calculates the `current_hash` via Web Crypto SHA-256 for WORM chaining.
* Implements Exponential Backoff ($T_{retry} = Base \times 2^{Attempt}$) on HTTPS failures when pushing to the Control Plane.

---
**END OF SPECIFICATION**
