# Complete Project Guide: Version 1 (Business Logic)

This document is the current-state source of truth for the DPDP/PMLA Compliance Engine. It reflects the finalized engine logic, including S3 blob lifecycle management and digitally signed PDF certification.

## 1. System Position & Architecture
The system operates on a **Two-Plane Zero-Trust Model**:
*   **Control Plane (API):** Central orchestrator. Manages schedules, task materialization, and legal certification. **Zero-PII Egress:** It never ingests raw user data.
*   **Data Plane (Worker):** Local executor. Runs inside the client VPC. Mutates the database, encrypts PII, and purges S3 objects.

## 2. Key Components (Implemented)

### 2.1 Control Plane API
*   **Identity:** UUID-based worker authorization.
*   **Safety Gate:** Mandatory shadow-mode "Burn-in" (100 successes) before live mutations.
*   **WORM Ledger:** Hash-chained audit logs using SHA-256.
*   **PDF Generator:** Native `pdf-lib` implementation to generate signed "Proof of Erasure" certificates.
*   **Task Materializer:** Lazily creates `NOTIFY` and `SHRED` tasks based on worker-reported retention.

### 2.2 Data Plane Worker
*   **Graph Engine:** Recursive CTE discovery with `max_depth: 32` and circular reference protection.
*   **Crypto Engine:** AES-256-GCM vaulting with RAM-only KEK management.
*   **S3 Provider:** Native SigV4 client for versioned hard-purges and Legal Holds.
*   **KMS Providers:** Integrated adapters for AWS KMS, GCP Secret Manager, and HashiCorp Vault.
*   **Liability Firewall:** Schema drift detection and DPO attestation enforcement.

## 3. Cryptographic Lifecycle

### 3.1 Vaulting (Stage 1)
1.  Worker locks the root row (`SELECT FOR UPDATE`).
2.  Discovers dependencies and evaluates PMLA vs. DPDP retention rules.
3.  Encrypts PII with a unique DEK; wraps DEK with the Master KEK.
4.  Pseudonymizes live identifiers (HMAC-SHA256).
5.  Applies **S3 Object Lock (Legal Hold)** to linked blobs.

### 3.2 Notification (Stage 2)
1.  Worker claims `NOTIFY_USER` task.
2.  Unwraps DEK and decrypts PII in RAM only.
3.  Dispatches mail using a deterministic idempotency key.

### 3.3 Shredding (Stage 3)
1.  **Key Destruction:** Deletes the user's unique DEK from `user_keys`.
2.  **Blob Purge:** Enumerates all S3 versions and delete markers; executes a permanent purge.
3.  **WORM Append:** Logs `SHRED_SUCCESS` with HMACed receipts.

### 3.4 Certification (Stage 4)
1.  API verifies the final WORM hash chain.
2.  Mints an Ed25519 digital signature.
3.  Generates the **Signed PDF Certificate** for the DPO.

## 4. Operational Guardrails
*   **Fail-Closed Startup:** Refuses to boot if the database schema hash differs from the signed manifest.
*   **Memory Safety:** Explicit zeroing of plaintext and key buffers (`.fill(0)`) after crypto operations.
*   **Prioritized Outbox:** The relay ensures that terminal legal events (`SHRED_SUCCESS`) are prioritized during catch-up cycles.
*   **SSRF Protection:** Strict validation of webhook URLs; loopback and private IP ranges are rejected.

---
*Last Updated: April 25, 2026*
