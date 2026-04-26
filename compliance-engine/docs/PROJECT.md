Here is the complete, top-down technical documentation for your Zero-Trust Sidecar Worker. This document serves as the absolute source of truth for the worker's operational lifecycle, explicitly detailing the configuration-driven liability firewall and the exact state transitions.

-----

# DPDP Compliance Engine: Worker Node Specification

## 1\. System Position & Architectural Philosophy

The worker operates strictly within the **Data Plane**. It is deployed as an isolated sidecar within the client's Virtual Private Cloud (VPC).

**The Zero-Trust Mandate:** The Central API (Control Plane) never ingests, processes, or stores raw Personally Identifiable Information (PII). All cryptographic mutation, relational graph discovery, object erasure, and data redaction occur locally via the worker. The worker maintains egress-only network access to poll for instructions and dispatch metadata-only WORM receipts. The Control Plane mints Certificates of Erasure after terminal worker events.

-----

## 2\. The Liability Firewall (Configuration)

The worker requires explicit, deterministic initialization. It does not rely on implicit defaults, shifting misconfiguration liability entirely to the client's Data Protection Officer (DPO). This is enforced via the `compliance.worker.yml` file.

### Explicit Target Declaration

The worker executes graph traversal for relational data, but for unlinked data, **the client must explicitly map the topology**.

  * **Relational Root:** The client defines the `app_schema`, `root_table`, `root_id_column`, and every PII-bearing root column.
  * **Satellite Targets (Unlinked PII):** The client must explicitly list every non-relational table containing PII. The worker will only touch the tables declared in this configuration matrix.
  * **Blob Targets (Object PII):** The client must explicitly list every S3 URL column containing documents, images, or other PII-bearing objects. The worker stores raw Bucket/Key/VersionID only in the local engine schema and sends only HMACed receipts to the Control Plane.
  * **Legal Attestation:** The YAML must include DPO identity, configuration version, legal review date, and acknowledgment text.
  * **Retention Citations:** Every retention rule must include a legal citation that is carried into worker payloads and certificates.

**Example Matrix:**

```yaml
satellite_targets:
  - table: "marketing_leads"
    lookup_column: "user_email_hash"
    action: "redact"
    masking_rules:
      name: "STATIC_MASK"
      phone_number: "HMAC"
blob_targets:
  - table: "users"
    column: "kyc_document_url"
    provider: "aws_s3"
    region: "ap-south-1"
    action: "versioned_hard_delete"
    retention_mode: "governance"
    require_version_id: true
```

-----

## 3\. The Cryptographic Core

The worker utilizes native C++ bindings via the **Bun Web Crypto API** (`globalThis.crypto`) for maximum concurrency and compliance with strict audit standards.

  * **Envelope Encryption:**
      * **KEK (Key Encrypting Key):** A 256-bit AES master key resolved at boot and kept in process memory.
      * **DEK (Data Encrypting Key):** A dynamic, per-user 256-bit AES key generated during vaulting.
  * **Data Integrity:** All PII is encrypted using **AES-256-GCM**, appending a 16-byte Auth Tag to instantly detect tampering.
  * **Referential Integrity:** Public IDs and identifiers are replaced with **HMAC-SHA256** pseudonyms, allowing the client to maintain analytical counts without identifying users.

-----

## 4\. The Execution Lifecycle: Top-Down Cycle

The worker's operation is an infinite loop of deterministic state transitions. Here is the exact cycle of a `VAULT_USER` instruction.

| Phase | Operation | Where it Happens | How it Executes (Mechanisms) |
| :--- | :--- | :--- | :--- |
| **Phase 1: Pre-Flight Validation** | Schema Assertion & Drift Detection | **VPC / RAM**<br>*(On Boot)* | Parses `compliance.worker.yml`. Hashes `information_schema.columns` via Web Crypto SHA-256 to verify the database matches the allowed topology. Halts on drift detection. |
| **Phase 2: Task Polling** | Egress Sync | **Network**<br>*(Continuous)* | Uses a bounded short-poll loop against the Control Plane via HTTPS. Receives opaque instructions (e.g., `{ task_type: "VAULT_USER", userId: 1042 }`). |
| **Phase 3: Graph Discovery** | Relational Footprint Mapping | **Primary DB for live mutation**<br>*(Task Start)* | Live execution locks the root row first, then executes Recursive CTE discovery in the same consistency boundary. Dry-run/shadow execution may offload reads to a replica. |
| **Phase 4: Satellite Redaction** | Unlinked PII Processing | **Primary DB**<br>*(Mutation Phase)* | Iterates through explicit `satellite_targets`. Executes Cursor-Based Batching to avoid deadlocks:<br>`WITH batch AS (SELECT id FROM targets LIMIT 1000 FOR UPDATE SKIP LOCKED) UPDATE...` |
| **Phase 5: Atomic Vaulting** | Cryptography & State Transition | **Primary DB**<br>*(Mutation Phase)* | Opens `REPEATABLE READ` transaction. Locks the root row (`SELECT FOR UPDATE`). Generates DEK, encrypts PII, wraps DEK, generates HMAC pseudonyms, and inserts into `pii_vault`. |
| **Phase 5B: Blob Protection** | S3 Legal Hold & URL Masking | **S3 + Primary DB**<br>*(Mutation Phase)* | For configured `blob_targets`, resolves S3 object versions, applies Object Lock Legal Hold, optionally writes a sanitized placeholder, records raw object coordinates locally, and replaces live URL values with HMAC pseudonyms. |
| **Phase 6: The Outbox Commit** | Tamper-Evident Logging | **Primary DB**<br>*(Transaction End)* | Enqueues a `USER_VAULTED` event. Hashes the payload against the `previous_hash` (Hash Chaining) for WORM compliance. Commits the transaction. |
| **Phase 7: Network Relay** | Metadata Dispatch | **Background Loop**<br>*(Continuous)* | Claims outbox events via `FOR UPDATE SKIP LOCKED`. Dispatches to Control Plane. Applies exponential backoff ($T_{retry} = base \times 2^{attempt}$) for failures. |

-----

## 5\. End-of-Life States (Notice & Shredding)

Vaulting is Stage 1. The worker does not track legal calendars in memory. The Control Plane owns cooldown, notice, and shred scheduling; the worker executes only the task it leases.

### The Notice Handshake (Stage 2)

  * **When:** The Control Plane materializes `NOTIFY_USER` when the worker-reported `notification_due_at` has arrived.
  * **What:** The worker reserves the vault row via an idempotent lease. It unwraps the DEK, decrypts the payload in RAM, fires an email webhook to the user, and clears the memory immediately. It logs `NOTIFICATION_SENT` to the outbox.

### The Crypto-Shredder (Stage 3)

  * **When:** The Control Plane materializes `SHRED_USER` when the worker-reported `shred_due_at` has arrived.
  * **What:** The absolute terminal state. The worker locks the vault, verifies the notice was sent, purges configured S3 blob versions, and executes a hard `DELETE` on the user's specific DEK within `user_keys`.
  * **Result:** The AES-256-GCM payload in the vault becomes mathematically impossible to decrypt. The row is updated with a sentinel marker `{ "destroyed": true }`, and S3 receipts are added to `SHRED_SUCCESS` without raw object paths.

-----

## 6\. Observability & Infrastructure Requirements

To ensure the engine can be safely deployed and monitored by enterprise DevOps teams:

  * **Containerization:** The worker is packaged with a least-privilege Docker/Kubernetes runtime posture.
  * **SRE Integration (Prometheus):** A native Bun HTTP server exposes a `/metrics` route.
      * Monitors `dpdp_outbox_queue_depth` to alert on network dispatch stalls.
      * Monitors `dpdp_dead_letters_total` to track permanently failed state transitions.
  * **Shadow Mode:** The worker supports a reversible dry-run configuration. It executes the full graph discovery, locking, and cryptographic overhead, but throws a controlled rollback at the end to benchmark production infrastructure without mutating data.
