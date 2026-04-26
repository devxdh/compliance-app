# Zero-Trust DPDP Compliance Engine Worker

This package contains the **worker/data-plane** side of the compliance engine. It lives inside the root compliance platform monorepo, runs inside the client's network, reads and mutates the client's PostgreSQL database locally, and only sends metadata out through a controlled outbox.

## What This Worker Does

### Layman Terms

When a user says "delete my account," the company is stuck between two rules:

- One law says personal data should be erased quickly.
- Other financial rules say some records must stay available for years.

This worker solves that by doing four things:

1. It hides the user's visible identity behind a fake stand-in.
2. It locks the real details in an encrypted vault.
3. It waits until the legal retention clock is almost finished, then sends a final warning notice.
4. It destroys the only key that can unlock the vault, which makes the original data permanently unreadable.

### Engineering Terms

The worker is a **zero-egress cryptographic state machine** built around:

- `AES-256-GCM` for authenticated PII encryption.
- Envelope encryption with a RAM-only KEK and per-user DEKs.
- `HMAC-SHA256` for stable worker hashes and pseudonym generation.
- Recursive PostgreSQL graph traversal for foreign-key discovery.
- A transactional outbox with leases, retries, and dead-letter handling.
- Time-gated notice and shred stages with idempotent state transitions.
- Native S3 SigV4 blob lifecycle actions for configured object references.
- Runtime key resolution from env/file, AWS KMS, GCP Secret Manager, or HashiCorp Vault.

## Production Guarantees In This Version

- Vaulting is atomic and runs in `REPEATABLE READ`.
- Replaying the same vault, notice, or shred command is safe and idempotent.
- The notice step uses a short DB lease so two workers do not double-send mail.
- The shred step refuses to run before retention expiry.
- The shred step requires a sent notice by default.
- The outbox uses leasing instead of holding row locks during network calls.
- Failed outbox deliveries back off exponentially and move to `dead_letter` after a configurable retry limit.
- Dry-run mode exists for vault, notice, and shred paths.
- Worker configuration is validated up front, including secret decoding and schema-name validation.
- Worker configuration requires DPO legal attestation and rule-level legal citations.
- Live vaulting locks the root row before graph traversal and retention evaluation.
- Critical transactions set local `lock_timeout` and fail closed on contention.
- Plaintext buffers and DEKs are wiped with `.fill(0)` after cryptographic use.
- Config hash, config version, and DPO identifier are sent to the Control Plane on sync.

## Repository Map

- [src/crypto/aes.ts](src/crypto/aes.ts)
  AES-GCM encrypt/decrypt primitives.
- [src/crypto/envelope.ts](src/crypto/envelope.ts)
  DEK generation plus KEK wrapping.
- [src/crypto/hmac.ts](src/crypto/hmac.ts)
  One-way hashing utilities for stable worker identifiers.
- [src/db/graph.ts](src/db/graph.ts)
  Recursive foreign-key discovery with cycle protection and depth-limit failure.
- [src/db/migrations.ts](src/db/migrations.ts)
  Worker schema provisioning for vault, key ring, and outbox tables.
- [src/config/worker.ts](src/config/worker.ts)
  Environment validation and worker defaults.
- [src/engine/vault/](src/engine/vault/)
  Stage 1 vaulting, evidence retention, dynamic mutation, shadow rollback, satellite orchestration, and hard-delete fast path.
- [src/engine/notifier/](src/engine/notifier/)
  Notice leasing, PII decrypt-in-memory, payload extraction, and mail dispatch.
- [src/engine/shredder.ts](src/engine/shredder.ts)
  Stage 4 crypto-shredding with legal/timing checks.
- [src/engine/blob/](src/engine/blob/)
  Blob target discovery, local object receipt store, S3 legal hold, and version-aware purge.
- [src/network/outbox/](src/network/outbox/)
  Batch claiming, retry policy, dead-letter handling, and fetch-based dispatch support.
- [src/network/s3-client.ts](src/network/s3-client.ts)
  Native AWS S3 SigV4 transport without AWS SDK runtime dependency.
- [src/config/kms.ts](src/config/kms.ts)
  Runtime secret/key retrieval for env/file, AWS KMS, GCP Secret Manager, and HashiCorp Vault.
- [tests/](tests/)
  Integration-style worker tests against PostgreSQL plus config/crypto tests.

## Environment Configuration

The worker reads `compliance.worker.yml` plus runtime secrets. The YAML is the legal contract; env vars and secret files provide credentials only.

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | Primary client PostgreSQL DSN | `postgres://postgres:postgres@localhost:5432/postgres` |
| `API_BASE_URL` | Base URL for worker task acknowledgements | `http://localhost:3000/api/v1/worker/tasks` |
| `API_SYNC_URL` | Worker sync endpoint | `http://localhost:3000/api/v1/worker/sync` |
| `API_OUTBOX_URL` | Worker outbox ingestion endpoint | `http://localhost:3000/api/v1/worker/outbox` |
| `API_CLIENT_ID` | Worker client id/name registered in the Control Plane | `worker-1` |
| `API_WORKER_TOKEN` / `_FILE` | Worker bearer token | `worker-secret` fallback for local only |
| `API_REQUEST_SIGNING_SECRET` / `_FILE` | Optional worker request-signing secret | _unset_ |
| `MAILER_WEBHOOK_URL` | Required mailer transport webhook | Required for production boot |
| `MAILER_TIMEOUT_MS` | Mailer webhook timeout | `10000` |
| `METRICS_PORT` | Worker health/metrics port | `9464` |
| `DPDP_MASTER_KEY` / `_FILE` | 32-byte KEK when YAML uses env/file key source | Required unless remote KMS source is configured |
| `DPDP_HMAC_KEY` / `_FILE` | 32-byte HMAC key when YAML uses env/file key source | Falls back to KEK only for local/dev source modes |

Supported secret formats:

- raw 64-character hex: `4242...`
- prefixed hex: `hex:4242...`
- raw base64
- prefixed base64: `base64:...`

YAML-required legal fields include:

- `legal_attestation.dpo_identifier`
- `legal_attestation.configuration_version`
- `legal_attestation.legal_review_date`
- `legal_attestation.acknowledgment`
- `compliance_policy.retention_rules[].legal_citation`
- `graph.root_pii_columns`
- `satellite_targets`
- `integrity.expected_schema_hash`

## Local Verification

From the monorepo root:

```bash
bun run engine:typecheck
bun run engine:test
```

If you are already inside `compliance-engine/`, the package-local equivalents are:

```bash
bun run typecheck
bun run test
```

The tests expect a reachable PostgreSQL instance. By default they use:

```text
postgres://postgres:postgres@localhost:5432/postgres
```

Override it with `TEST_DATABASE_URL` if needed.

## Test Coverage Highlights

- AES key length validation and tamper detection.
- Config parsing and malformed-secret rejection.
- Deep recursive graph traversal, cycle handling, and fail-closed depth limits.
- FK cascade/set-null guardrail failures.
- Vault decryptability, rollback behavior, hard-delete fast path, and idempotent replay.
- Notice due-window enforcement, lease cleanup after mail failure, and duplicate-send protection.
- Shred timing/notice fail-safes and post-shred destroyed sentinel verification.
- Outbox retry scheduling, dead-lettering, expired lease recovery, and concurrent batch claiming.
- S3 SigV4 signing, S3 blob legal hold/version purge logic, and HMACed blob receipts.
- Worker retry behavior for Control Plane task acknowledgements.

## Operational Notes

- This worker keeps **raw PII local**. Only metadata leaves through the outbox.
- After shredding, the local vault row keeps non-PII audit metadata but replaces ciphertext with a destroyed sentinel.
- The worker intentionally fails closed when FK traversal hits its recursion limit or configuration is invalid.
- Production boot requires a real mailer webhook transport; the worker no longer silently uses a mock mailer.
- The worker uses bounded 5-second short-polling against the Control Plane rather than true held long-polling.
- Live execution reads from the primary transaction for TOCTOU safety. Replica routing is used only where it does not weaken consistency, such as dry-run/shadow reads.

## Further Documentation

- [docs/software-requirements-specification.md](docs/software-requirements-specification.md)
- [docs/product-requirements-document.md](docs/product-requirements-document.md)
- [docs/architecture-design-document.md](docs/architecture-design-document.md)
- [docs/technical-design-document.md](docs/technical-design-document.md)
- [docs/backlog.md](docs/backlog.md)
