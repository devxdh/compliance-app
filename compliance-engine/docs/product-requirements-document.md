# Product Requirements Document

## Product Summary

The compliance engine resolves the retention paradox between privacy-driven deletion requests and multi-year financial retention mandates. This repository implements the **worker**, which is responsible for all sensitive local execution inside the customer's trust boundary.

## User Outcomes

### For Operators

- They can vault, notify, and shred with deterministic, testable behavior.
- They can inspect dry-run plans before mutating production data.
- They can rely on retryable outbox delivery instead of best-effort API calls.
- They can ensure compliance via Tamper-Evident Outbox sequences guaranteeing append-only auditability.
- They can protect data via automated Schema Drift Detection preventing unsafe mutations.

### For Auditors / Security Reviewers

- They can see that raw PII never leaves the local environment.
- They can verify that key destruction, not bulk row scanning, is the final erasure primitive.
- They can inspect durable metadata proving that notice and shred steps were executed in order.

### For New Engineers

- They can understand the worker in both business terms and technical terms through code comments and docs.
- They can run a focused test suite that exercises cryptography, SQL traversal, and worker state transitions.

## Scope In This Repository

- Cryptographic worker primitives
- Worker-owned PostgreSQL schema and migrations
- Vault / notice / shred operations
- Transactional outbox relay logic
- Worker-focused documentation and tests

## Out Of Scope

- Central API orchestration and certificate signing
- Billing and multi-tenant control-plane features
- Deployment manifests and container packaging
