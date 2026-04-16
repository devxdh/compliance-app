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
- [src/engine/vault.ts](src/engine/vault.ts)
  Stage 1 vaulting and hard-delete fast path.
- [src/engine/notifier.ts](src/engine/notifier.ts)
  Stage 3 notice leasing and local mail dispatch.
- [src/engine/shredder.ts](src/engine/shredder.ts)
  Stage 4 crypto-shredding with legal/timing checks.
- [src/network/outbox.ts](src/network/outbox.ts)
  Batch claiming, retry policy, dead-letter handling, and fetch-based dispatch support.
- [tests/](tests/)
  Integration-style worker tests against PostgreSQL plus config/crypto tests.

## Environment Configuration

The worker config reader expects these environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `DPDP_MASTER_KEY` | 32-byte KEK in hex or base64 | Required |
| `DPDP_HMAC_KEY` | 32-byte HMAC key in hex or base64 | Falls back to `DPDP_MASTER_KEY` |
| `DPDP_APP_SCHEMA` | Client application schema | `mock_app` |
| `DPDP_ENGINE_SCHEMA` | Worker schema | `dpdp_engine` |
| `DPDP_RETENTION_YEARS` | Retention period for vaulted PII | `5` |
| `DPDP_NOTICE_WINDOW_HOURS` | Time before shredding when notice is allowed | `48` |
| `DPDP_GRAPH_MAX_DEPTH` | Maximum FK recursion depth before fail-closed | `32` |
| `DPDP_OUTBOX_BATCH_SIZE` | Outbox batch size per poll | `10` |
| `DPDP_OUTBOX_LEASE_SECONDS` | How long a claimed outbox batch stays leased | `60` |
| `DPDP_OUTBOX_MAX_ATTEMPTS` | Max delivery retries before dead-letter | `10` |
| `DPDP_OUTBOX_BASE_BACKOFF_MS` | Base exponential backoff in milliseconds | `1000` |
| `DPDP_NOTIFICATION_LEASE_SECONDS` | Lease duration for pre-erasure notices | `120` |

Supported secret formats:

- raw 64-character hex: `4242...`
- prefixed hex: `hex:4242...`
- raw base64
- prefixed base64: `base64:...`

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
- Vault decryptability, rollback behavior, hard-delete fast path, and idempotent replay.
- Notice due-window enforcement, lease cleanup after mail failure, and duplicate-send protection.
- Shred timing/notice fail-safes and post-shred destroyed sentinel verification.
- Outbox retry scheduling, dead-lettering, expired lease recovery, and concurrent batch claiming.

## Operational Notes

- This worker keeps **raw PII local**. Only metadata leaves through the outbox.
- After shredding, the local vault row keeps non-PII audit metadata but replaces ciphertext with a destroyed sentinel.
- The worker intentionally fails closed when FK traversal hits its recursion limit or configuration is invalid.
- The default `sendToAPI` helper is deterministic and test-friendly; production code should inject `createFetchDispatcher(...)` or another transport.

## Further Documentation

- [docs/software-requirements-specification.md](docs/software-requirements-specification.md)
- [docs/product-requirements-document.md](docs/product-requirements-document.md)
- [docs/architecture-design-document.md](docs/architecture-design-document.md)
- [docs/technical-design-document.md](docs/technical-design-document.md)
- [docs/backlog.md](docs/backlog.md)
