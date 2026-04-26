# Worker Backlog

This backlog tracks worker/data-plane work only. Cross-product launch items live in [../../docs/SHIP_READINESS.md](../../docs/SHIP_READINESS.md).

## Completed

- Tamper-evident outbox with `previous_hash`, `current_hash`, canonical payload hashing, and idempotency-key binding.
- Schema drift detection against `information_schema.columns`.
- Fail-fast startup guards for schema hash mismatch and signed config validation.
- Strict YAML configuration with DPO legal attestation, rule citations, root PII mappings, satellite targets, blob targets, and schema integrity hash.
- Native KMS/runtime secret adapters for env/file, AWS KMS, GCP Secret Manager, and HashiCorp Vault.
- HMAC-backed worker hashes and pseudonyms.
- `REPEATABLE READ` live vaulting with root-row `SELECT FOR UPDATE`.
- Lock timeout hardening for critical transactions.
- Dynamic root-table and root-column mutation using `postgres.js` identifier escaping.
- Evidence-based retention evaluation with longest-rule selection.
- Referential-integrity guardrail for unsafe FK `ON DELETE CASCADE`, `SET NULL`, and `SET DEFAULT`.
- Reversible shadow mode.
- Satellite redaction/deletion chunking with `FOR UPDATE SKIP LOCKED` and event-loop yielding.
- S3 blob legal hold, version-aware purge, overwrite support, and HMACed blob receipts.
- Durable notice and shred metadata.
- Notification reservation leases and production mailer webhook transport.
- Outbox leases, retry counts, backoff scheduling, prioritized terminal catch-up, and dead-letter state.
- Worker metrics, readiness, and health endpoints.
- Structured Pino logging and standardized `WorkerError`.
- Adversarial and integration tests for config poisoning, graph traps, TOCTOU, crypto corruption, S3 logic, outbox retries, schema drift, retention, notice, shred, and worker retry behavior.

## Remaining Worker-Specific Work

- Add provider-specific integration tests against real AWS/GCP/Vault sandboxes before enterprise deployment.
- Add load benchmarks for very large FK graphs and multi-million-row satellite targets.
- Add tenant-specific performance profiles and recommended Postgres indexes generated from `compliance.worker.yml`.
- Add CLI tooling for schema graph preview and dry-run reports before installing the sidecar.
- Add signed binary/release attestation for the worker image.
