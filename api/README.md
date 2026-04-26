# Avantii Control Plane API

Metadata-only Control Plane for the DPDP/PMLA Compliance Engine, built for Bun with:

- `hono`
- `zod`
- `@hono/zod-validator`
- `postgres.js`
- Web Crypto (`globalThis.crypto`) for token hashing, WORM hashes, request signing, and Ed25519 Certificate of Erasure signatures
- `pdf-lib` for signed PDF Certificate of Erasure generation
- `pino` and `prom-client` for operational logging and metrics

## Runtime

```bash
bun install
bun run api:typecheck
bun run api:test
bun run api:dev
```

## Environment

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL DSN | `postgres://postgres:postgres@localhost:5432/postgres` |
| `API_CONTROL_SCHEMA` | API schema name | `dpdp_control` |
| `PORT` | HTTP port | `3000` |
| `WORKER_TASK_LEASE_SECONDS` | Task lease duration | `60` |
| `COE_KEY_ID` | CoE signing key identifier | `control-plane-ed25519-v1` |
| `COE_PRIVATE_KEY_PKCS8_BASE64` | Optional Ed25519 private key | _unset_ |
| `COE_PUBLIC_KEY_SPKI_BASE64` | Required when private key is set | _unset_ |
| `ADMIN_API_TOKEN` | Bearer token for `/api/v1/admin/*` | `admin-secret` |
| `WORKER_REQUEST_SIGNING_SECRET` | Optional HMAC signing secret for worker requests | _unset_ |
| `SHADOW_BURN_IN_REQUIRED` | Require shadow-mode successes before live mutation | `true` in deployment manifests |
| `SHADOW_REQUIRED_SUCCESSES` | Shadow successes required for live mutation | `100` |
| `TASK_MAX_ATTEMPTS` | Task retry limit before DLQ | `10` |
| `TASK_BASE_BACKOFF_MS` | Base retry backoff | `1000` |

If no keypair env vars are provided, the API generates an in-memory Ed25519 keypair at boot.

## API Surface

- `POST /api/v1/erasure-requests`
  - Creates a metadata-only erasure job and stores `vault_due_at` using Postgres time math.
- `POST /api/v1/erasure-requests/:idempotency_key/cancel`
  - Cancels a job while it is still in `WAITING_COOLDOWN`.
- `GET /api/v1/worker/sync`
  - Logs worker config hash heartbeat, materializes due tasks, and leases the next worker task (`FOR UPDATE SKIP LOCKED`).
- `POST /api/v1/worker/tasks/:taskId/ack`
  - Persists worker task completion/failure and applies retry/DLQ policy.
- `POST /api/v1/worker/outbox`
  - Ingests worker metadata events (`USER_VAULTED`, `NOTIFICATION_SENT`, `SHRED_SUCCESS`).
  - Verifies hash chaining, records usage, updates job state, finalizes webhooks, and mints signed CoE on `SHRED_SUCCESS`.
- `GET /api/v1/certificates/:requestId`
  - Returns the signed certificate payload + signature.
- `GET /api/v1/certificates/:requestId/download`
  - Returns the signed Certificate of Erasure PDF.
- `GET /api/v1/admin/*`
  - Admin-only usage, client management, audit export, erasure request detail, and DLQ recovery endpoints.
- `GET /metrics`
  - Prometheus metrics.

## Testing

- Unit tests cover Ed25519 signing/verification, WORM hash determinism, request signing, and standardized errors.
- Integration tests cover request lifecycle, admin endpoints, PDF generation, blob receipts, outbox replay, validation rejection, worker auth failures, and certificate availability.

Integration tests require a reachable PostgreSQL at `TEST_DATABASE_URL` (or default localhost DSN).

## Security Notes

- The API never accepts raw PII in erasure requests.
- Equivalent idempotent retries are accepted; conflicting replays are rejected.
- The web dashboard must call admin endpoints from server-side code only.
- Prisma/ORMs are intentionally not used because queue leasing, hash-chain reads, recursive/stateful SQL, and Postgres time math are security-sensitive.
