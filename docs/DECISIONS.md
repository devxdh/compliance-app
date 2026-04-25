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
**Rationale:** Standard S3 deletes only hide data. For DPDP/GDPR compliance, "Permanent Erasure" requires purging the object's entire version history.

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
