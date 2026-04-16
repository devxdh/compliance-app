### Phase 1: Project Identity & Scope (The "Why" & "What")

#### The Core Problem: The Retention Paradox
Indian tech companies face conflicting legal mandates:
1.  **DPDP Act 2023 (Section 8):** Mandates immediate erasure of Personal Identifiable Information (PII) upon consent withdrawal or purpose fulfillment.
2.  **PMLA 2002 (Section 12) & RBI Directives:** Mandate the retention of financial transaction logs and user identities for 5 to 8 years to prevent fraud and money laundering.

#### The Solution: The Zero-Trust Erasure Engine
The application acts as a deterministic state machine that legally resolves this paradox. It separates a user's *Identity* from their *Activity*. It pseudonymizes data for the mandatory retention period and executes mathematically irreversible crypto-shredding exactly when the legal timer expires.

#### Scope of Operations (What It Performs)
* **Envelope Encryption & Pseudonymization:** Swaps live PII with HMAC hashes and securely vaults the raw data using a two-tier key architecture ($KEK$ and $DEK$).
* **Automated Legal Timers:** Monitors the multi-year gap between a deletion request and final statutory expiration.
* **Delegated Notifications (Outbound-Only):** Triggers legal compliance alerts by polling the central API and dispatching emails locally without pulling PII out of the client's network.
* **Crypto-Shredding:** Executes $O(1)$ Data Encrypting Key (DEK) deletion to achieve mathematical anonymization.
* **Legal Certification:** Generates tamper-proof, digitally signed Certificates of Erasure (CoE) for audits.

#### Strategic Avoidance (What It Explicitly Does NOT Do)
* **No Inbound Webhooks:** The engine never exposes an open port in the client's VPC. All network traffic is outbound via Long-Polling.
* **No Direct Key Storage:** It never stores raw symmetric keys in the database. It mandates Envelope Encryption.
* **No Proactive Tokenization:** This engine cleans up existing databases; it does not force clients to rewrite their applications to use data tokens from Day 1.
* **No ORMs or $O(n^2)$ Node.js Loops:** Graph traversal occurs natively inside Postgres using Recursive CTEs.

---

### Phase 2: Architectural Responsibilities (The "Who")

The system operates on a strict **Control Plane** vs. **Data Plane** architecture.

#### 1. The Central API (Control Plane / The Brain)
* **Role:** The Legal Sentry and Orchestrator.
* **Performs:**
    * Maintains the registry of all erasure jobs using non-identifiable hashes.
    * Calculates the overarching legal timelines ($T_{law} = \max(T_{PMLA}, T_{IT\_Act})$).
    * Manages the Long-Polling queue for Worker synchronization.
    * Mints the Ed25519-signed Certificate of Erasure upon verified completion.
    * Meters usage and handles client billing via the Worker's Outbox payloads.

#### 2. The Local Worker (Data Plane / The Muscle)
* **Role:** The Cryptographic Executioner.
* **Performs:**
    * Runs strictly inside the client's Virtual Private Cloud (VPC) as a Distroless background process.
    * Introspects the client's database via Recursive CTEs to map dependencies atomically.
    * Generates Data Encrypting Keys (DEKs) and encrypts them using the RAM-only Key Encrypting Key (KEK).
    * Executes database mutations using atomic transactions (`REPEATABLE READ`).
    * Pushes strict "Success/Failure" metadata manifests to the API via the Transactional Outbox pattern.

---

### Phase 3: The Erasure Lifecycle (The "When")

This is the exact sequence of events the application must support for every user. Let $S$ represent the state.

#### Stage 0: $S_0 \rightarrow S_1$ (Initiation & Grace Period)
* **Trigger:** User clicks "Delete Account" on the client's app.
* **App Action:** The API registers the request. The Worker marks the target account as `RECOVERY_PENDING`.
* **Scope:** Initiates a 30-day compliance hold. No cryptographic operations occur. If the user logs back in, the operation is atomically aborted.

#### Stage 1: $S_1 \rightarrow S_2$ (Pseudonymization / The Vaulting)
* **Trigger:** The 30-day grace period expires without account recovery.
* **App Action:**
    * The Worker generates a unique $DEK_{raw}$ and a hashing salt.
    * Raw PII is encrypted: $Ciphertext = \text{AES\_GCM}(PII, DEK_{raw})$.
    * The key is protected: $DEK_{stored} = E_{KEK}(DEK_{raw})$.
    * Raw PII in the main table is replaced with a one-way HMAC hash.
    * Success event is written to `dpdp_engine.outbox` in the same Postgres transaction.
* **Scope:** PMLA/RBI compliance is achieved. DPDP compliance initiates. 

#### Stage 2: $S_2$ (Statutory Retention / The Hold)
* **Trigger:** Vaulting is complete.
* **App Action:** The Worker sets a local hard-limit timer. The API sets a parallel tracking timer.
* **Scope:** The system passively waits for 5 to 8 years. If an auditor requests identity verification, the client's Data Protection Officer (DPO) uses the Worker's injected $KEK$ to decrypt the Vault.

#### Stage 3: $S_2 \rightarrow S_3$ (Delegated Pre-Erasure Notification)
* **Trigger:** The Worker's outbound Long-Poll receives a signal from the API that the legal timer is 48 hours away from zero.
* **App Action:**
    * The Worker decrypts the user's contact info locally into RAM.
    * The Worker dispatches the "Right to Portability/Erasure" warning via the client's SMTP server.
    * PII is flushed from RAM; Outbox is updated.
* **Scope:** Satisfies the DPDP principle of transparency without violating the Zero-Egress security model.

#### Stage 4: $S_3 \rightarrow S_4$ (Crypto-Shredding / Final Anonymization)
* **Trigger:** The 48-hour notice window expires.
* **App Action:**
    * The Worker verifies the local legal timer has actually expired.
    * The Worker permanently deletes the encrypted DEK associated with that user (`DELETE FROM dpdp_engine.user_keys`).
    * The Worker drops the Vault row.
* **Scope:** The $O(1)$ metadata deletion renders gigabytes of historical transaction data mathematically unrecoverable. Legal transition from "Personal Data" to "Anonymous Data" is complete.

#### Stage 5: $S_4 \rightarrow S_5$ (Certification)
* **Trigger:** The Worker's Outbox syncs the final shredding manifest to the API.
* **App Action:** The API compiles the metadata (Target Hash, Timestamp, Legal Framework, Method) into a PDF/JSON document and signs it with the platform's Ed25519 private key.
* **Scope:** Provides the client with a legally defensible artifact for regulatory audits.

---

### Phase 4: Required Engineering Capabilities (The "How It Works")

To fulfill the lifecycle, your application must build the following distinct capabilities:

1.  **Native Graph Traversal:** The Worker must execute a Recursive CTE against Postgres `pg_constraint` to map dependencies at $O(V+E)$ database-layer complexity. If zero dependencies exist, the Worker intelligently skips the 8-year vault and executes an immediate Hard Delete.
2.  **Transactional Outbox Pattern:** To prevent race conditions and silent network failures, the Worker must write its API payloads to a local `outbox` table *within* the vaulting transaction. A separate thread polls this table to sync with the API, guaranteeing at-least-once delivery.
3.  **Envelope Encryption:** The application must strictly enforce the isolation of the $KEK$ (Docker environment variable) from the $DEK$ (Postgres table).
4.  **Dry-Run (Audit) Mode:** Before mutating a client's production database, the Worker must support a mode that outputs the exact SQL queries and cryptographic steps it *intends* to take.

---

### Phase 5: Implementation Sequence (Your Build Order)

Follow this strict sequence using Bun, TypeScript, and `postgres.js`:

* **Step 1: Envelope Encryption Core (Local):** Build the KEK/DEK isolation logic using `node:crypto` (`AES-256-GCM`). Prove you can encrypt data, encrypt the key, and mathematically destroy access.
* **Step 2: Recursive CTE Graph Traversal (Local):** Write the advanced SQL query utilizing `pg_constraint` to dynamically traverse dependencies.
* **Step 3: The Vaulting Transaction & Outbox (Worker):** Combine Steps 1 and 2. Write the single `sql.begin()` block that mutates the target tables and writes to the `outbox` table atomically.
* **Step 4: The Long-Polling Network Layer (Worker/API):** Build the outbound network loop in the Worker that fetches commands from the API and drains the local Outbox.
* **Step 5: The Notification Handshake:** Implement the SMTP delegation logic triggered by the polling mechanism.
* **Step 6: Certification Generation:** Build the Ed25519 signing logic in the Central API to generate the CoE.