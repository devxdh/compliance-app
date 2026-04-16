# MASTER BLUEPRINT: Zero-Trust DPDP Compliance Engine

This is the definitive, mathematically sound, and enterprise-hardened specification for your compliance engine. It discards naive CRUD patterns in favor of Distributed State Machines, Envelope Encryption, and Egress-Only Networking. 

Feed this document directly to any AI agent as its **System Directive** to ensure flawless architectural execution.

---

## 1. System Identity & The Prime Directive
This system resolves the Indian legislative "Retention Paradox" (DPDP Act vs. PMLA/IT Act). 
It is a **Zero-Egress Cryptographic State Machine**. It separates *Identity* from *Activity* via pseudonymization, enforces statutory retention timers locally, and executes $O(1)$ crypto-shredding to achieve mathematical anonymization.

**The Prime Directive:** Raw Personal Identifiable Information (PII) must **never** leave the client's Virtual Private Cloud (VPC). The Central API acts strictly as a metadata coordinator and legal certification authority.

---

## 2. Architectural Blueprint: The Flawless Patterns

To pass enterprise CISO (Chief Information Security Officer) audits, this architecture implements four non-negotiable patterns:

### A. Egress-Only Networking (No Inbound Webhooks)
* **The Flaw:** Enterprise firewalls block inbound traffic. An API sending a webhook to a VPC will fail.
* **The Standard:** **Long-Polling / Outbound Connect.** The Worker initiates a persistent connection to the Brain API (`GET /sync`). The API holds the connection open until a command (like the 48-hour notice trigger) is ready.

### B. Envelope Encryption (KEK/DEK Isolation)
* **The Flaw:** Storing symmetric keys directly in the database means a leaked DB dump compromises all vaulted PII.
* **The Standard:** **Two-Tier Cryptography.** 1. **KEK (Key Encrypting Key):** A Master 32-byte key injected via Docker ENV (`DPDP_MASTER_KEY`). It lives *only* in Worker RAM.
    2. **DEK (Data Encrypting Key):** Unique AES-256 key per user.
    3. **Mechanism:** The DEK is encrypted by the KEK before storage: $DEK_{stored} = E_{KEK}(DEK_{raw})$. A stolen database is mathematically useless without the Docker environment variables.

### C. Recursive CTE Graph Traversal (No $O(n^2)$ Node.js Loops)
* **The Flaw:** Fetching table names to Node.js and looping through them with individual `SELECT` queries creates $O(n^2)$ network roundtrips, saturating the connection pool.
* **The Standard:** **Native Database Graph Traversal.** The Worker executes a single Recursive Common Table Expression (CTE) utilizing `pg_constraint` and `pg_class` to traverse the dependency graph entirely within Postgres's C++ engine. Complexity reduces to $O(V+E)$ at the database layer.

### D. The Transactional Outbox Pattern
* **The Flaw:** Worker vaults data $\rightarrow$ API network call fails $\rightarrow$ System state desynchronizes.
* **The Standard:** Worker writes the success manifest to a local `dpdp_engine.outbox` table *within the exact same PostgreSQL transaction* as the Vaulting operation. A background thread polls the outbox and guarantees at-least-once delivery to the Brain API.

---

## 3. Cryptographic & Security Protocol

| Operation | Primitive | Complexity / Standard |
| :--- | :--- | :--- |
| **Pseudonymization** | `HMAC-SHA256` | $H(PII + Local\_Salt)$. One-way identity masking. |
| **Data Vaulting** | `AES-256-GCM` | Authenticated encryption. `authTag` must be validated to prevent ciphertext tampering. |
| **Key Protection** | Envelope Encryption | $E_{KEK}(DEK_{raw})$. KEK is isolated from DB. |
| **Erasure (Shredding)** | $O(1)$ Key Deletion | `DELETE FROM user_keys`. Renders gigabytes of ciphertexts mathematically unrecoverable. |
| **Legal Certification** | `Ed25519` | Asymmetric signatures. Brain signs the final CoE. |

---

## 4. Database Topology (The Data Plane)

The Worker executes a migration to provision the `dpdp_engine` schema within the client's existing PostgreSQL database.

```sql
CREATE SCHEMA IF NOT EXISTS dpdp_engine;

-- The Vault: Stores the AES-256-GCM ciphertexts
CREATE TABLE dpdp_engine.pii_vault (
    user_uuid_hash TEXT PRIMARY KEY,
    encrypted_pii JSONB NOT NULL,
    salt TEXT NOT NULL,
    retention_expiry TIMESTAMP NOT NULL
);

-- The Key Ring: Stores the DEK, encrypted by the KEK
CREATE TABLE dpdp_engine.user_keys (
    user_uuid_hash TEXT PRIMARY KEY REFERENCES dpdp_engine.pii_vault(user_uuid_hash) ON DELETE CASCADE,
    encrypted_dek BYTEA NOT NULL 
);

-- The Outbox: Guarantees API synchronization
CREATE TABLE dpdp_engine.outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_uuid_hash TEXT NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 5. The Deterministic State Machine (Lifecycle)

Let $S$ represent the state of User $U$. Let $T_{law} = \max(T_{PMLA}, T_{IT\_Act})$.

### Stage 0: $S_0 \rightarrow S_1$ (Recovery Pending)
* **Trigger:** Deletion request initiated.
* **Action:** 30-day countdown begins. Data remains physically unaltered. `status` = `RECOVERY_PENDING`.

### Stage 1: $S_1 \rightarrow S_2$ (Pseudonymized Vaulting)
* **Trigger:** 30 days expire.
* **Atomic Execution:**
    1. `BEGIN;`
    2. Generate $DEK_{raw}$ and $Salt$.
    3. Calculate $Hash = \text{HMAC}(U_{ID} + Salt)$.
    4. Execute graph traversal. If $0$ dependencies $\rightarrow$ Hard Delete & Skip to Stage 4.
    5. $Ciphertext = \text{AES\_GCM}(PII, DEK_{raw})$.
    6. $DEK_{stored} = \text{AES\_GCM}(DEK_{raw}, KEK)$.
    7. `INSERT INTO dpdp_engine.pii_vault` and `dpdp_engine.user_keys`.
    8. `UPDATE public.users` (Replace PII with $Hash$).
    9. `INSERT INTO dpdp_engine.outbox` (Queue success webhook).
    10. `COMMIT;`

### Stage 2: $S_2$ (Statutory Hold)
* **Trigger:** Passive wait. Local timer set to $T_{law}$.

### Stage 3: $S_2 \rightarrow S_3$ (Delegated Notification)
* **Trigger:** Brain API flags $T_{law} - 48\text{ hours}$ via Long-Polling response.
* **Action:** Worker pulls $DEK_{stored}$, decrypts with KEK, decrypts PII into RAM, dispatches email via client's local SMTP, flushes RAM, queues outbox success.

### Stage 4: $S_3 \rightarrow S_4$ (Crypto-Shredding)
* **Trigger:** 48 hours expire. Local DB timer confirms $NOW() \geq retention\_expiry$.
* **Atomic Execution:** `DELETE FROM dpdp_engine.user_keys WHERE user_uuid_hash = Hash`.
* **Result:** Mathematical Anonymization achieved. DPDP Sec 8(7) satisfied.

### Stage 5: $S_4 \rightarrow S_5$ (Certification)
* **Trigger:** Brain API processes Shredding outbox event.
* **Action:** Brain generates CoE, signs with Ed25519 Private Key, and finalizes billing ledger.

---

## 6. Implementation Roadmap (Strict Build Order)

**Constraint:** Use `Bun`, `postgres.js`, and `TypeScript (ESM)`.

1. **Module 1: The Cryptographic Core (`src/crypto/`)**
   * Implement Envelope Encryption: `KEK` management, `DEK` generation, AES-256-GCM encryption/decryption with strict `authTag` validation.
2. **Module 2: The Graph Engine (`src/db/graph.ts`)**
   * Write the PostgreSQL CTE query that introspects `information_schema.key_column_usage` to find dependencies natively.
3. **Module 3: The Atomic State Machine (`src/engine/vault.ts`)**
   * Implement Stage 1 (Vaulting) inside a strict `postgres.js` transaction block (`sql.begin(async sql => { ... })`). Ensure isolation level prevents race conditions.
4. **Module 4: The Outbox Relay (`src/network/outbox.ts`)**
   * Build the background loop that drains the `dpdp_engine.outbox` table and pushes to the Brain API.
5. **Module 5: IP Obfuscation & Containerization**
   * Set up `javascript-obfuscator`.
   * Compile to a standalone binary: `bun build --compile --target=bun-linux-x64`.
   * Package in `gcr.io/distroless/cc-debian12`.

## 7. Strategic Avoidance (Anti-Patterns)
* **NO ORMs:** Prisma/TypeORM cannot dynamically handle unknown client schemas efficiently. Use raw `postgres.js`.
* **NO Node.js Event Loop Blocking:** Large cryptographic operations must use `worker_threads` or streams if dealing with heavy files (KYC PDFs).
* **NO "Smart" Guesses:** If the discovery query fails or is ambiguous, the Worker must **FAIL SAFE** (halt and alert), not guess and delete.
* **NO Local CoE Generation:** The Worker never signs the legal certificate. The Brain does. This maintains the Two-Factor Audit Trail.
