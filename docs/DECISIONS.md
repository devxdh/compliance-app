# The Intelligent Compliance Engine: Master Decisions & Liability Shield

### 1. Core Architectural Posture: Zero-Trust "Two-Plane" Split
**Decision:** Segregate PII mutation (Data Plane) from legal orchestration (Control Plane).
**Rationale:** The platform cannot leak what it does not have. This eliminates centralized data breach risk.

### 2. Identity & Authorization: UUID-Based Handshake
**Decision:** Shift from name-based to immutable UUID identification for Worker clients.
**Rationale:** Predictable names (e.g., `worker-1`) are vulnerable to ID-guessing. UUIDs harden the authentication boundary and allow clients to rename their display identities without breaking the cryptographic connection.

### 3. Native KMS Providers: Zero-Dependency Security
**Decision:** Implement AWS SigV4, GCP OAuth, and Vault REST logic using native `fetch` and Web Crypto.
**Rationale:** Including massive cloud SDKs increases the worker's binary size and attack surface. Native implementations ensure the engine is lightweight and auditable by conservative enterprise security teams (e.g., Banks).

### 4. S3 Object Lifecycle: Versioned Hard Purge
**Decision:** Explicitly enumerate and delete all S3 object versions and delete markers during shredding.
**Rationale:** Standard S3 deletes only hide data. For DPDP/PMLA-grade erasure evidence, "Permanent Erasure" requires purging the object's entire version history when retention expires.

### 5. Legal Object Lock: WORM Protection
**Decision:** Apply S3 Object Lock (Legal Hold) during the vaulting phase.
**Rationale:** Protects the Data Protection Officer (DPO) from liability for accidental early erasure. Ensures that KYC/PMLA retention mandates are physically enforced until the clock expires.

### 6. PDF Proof of Erasure: The Human Artifact
**Decision:** Utilize `pdf-lib` to generate digitally signed, high-contrast PDF certificates.
**Rationale:** Regulators and judges require human-readable proof. The PDF bridges the gap between the technical WORM ledger and the legal requirement for a definitive physical artifact. `pdf-lib` was chosen for its zero-dependency, pure-JS nature, which aligns with the Bun runtime's performance goals.

### 7. Explicit Configuration: The Liability Firewall
**Decision:** Enforce a "Zero-Guessing" policy via `compliance.worker.yml`.
**Rationale:** Shifting the burden of identifying PII to the client DPO protects the SaaS provider from legal liability for undocumented data leakage.

### 8. Concurrency & Integrity: REPEATABLE READ + Snapshot Locking
**Decision:** Execute a `SELECT FOR UPDATE` on the root entity *before* graph traversal.
**Rationale:** Eliminates TOCTOU (Time-of-Check to Time-of-Use) anomalies. Guarantees that the discovered dependency graph is consistent and immutable during the vaulting transaction.

### 9. Calendar Ownership: Lazy Executioner Model
**Decision:** The Control Plane owns all cooldown, notice, and shred scheduling. The Worker remains stateless and only executes tasks it leases.
**Rationale:** If a worker restarts or is offline, no legal timer is lost. Durable state lives in `erasure_jobs` and `task_queue`, not in sidecar memory.

### 10. Polling Transport: Bounded Short-Polling
**Decision:** Use a 5-second egress-only short-poll loop for `/api/v1/worker/sync`.
**Rationale:** This is simpler to deploy inside client VPCs than true long-polling with Postgres `LISTEN/NOTIFY` or a broker. The task lease and idempotency model are transport-agnostic, so long-polling can be added later without changing legal state transitions.

### 11. Web Dashboard: Server-Side BFF
**Decision:** The Next.js dashboard is a BFF. It calls admin endpoints only from server components, route handlers, and server actions.
**Rationale:** The browser must never receive `ADMIN_API_TOKEN` or worker credentials. Missing server config must produce an explicit configuration-required UI, not fake dashboard data.

### 12. ORM Avoidance
**Decision:** Do not add Prisma, TypeORM, or Sequelize to any package.
**Rationale:** The product depends on exact SQL semantics: `FOR UPDATE SKIP LOCKED`, `REPEATABLE READ`, Postgres time math, dynamic identifier escaping, recursive CTEs, and WORM chain-head reads. `postgres.js` keeps those semantics explicit and auditable.
