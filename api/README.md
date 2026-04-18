# DPDP Control Plane API

Control-plane bootstrap for the DPDP Compliance Engine, built for Bun with:

- `hono`
- `zod`
- `@hono/zod-validator`
- `postgres.js`
- Web Crypto (`globalThis.crypto`) for Ed25519 Certificate of Erasure signatures

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

If no keypair env vars are provided, the API generates an in-memory Ed25519 keypair at boot.

## API Surface

- `POST /api/v1/erasure-requests`
  - Creates control-plane request and enqueues initial `VAULT_USER` worker task.
- `GET /api/v1/worker/sync`
  - Leases the next worker task (`FOR UPDATE SKIP LOCKED`).
- `POST /api/v1/worker/tasks/:taskId/ack`
  - Persists worker task completion/failure.
- `POST /api/v1/worker/outbox`
  - Ingests worker metadata events (`USER_VAULTED`, `NOTIFICATION_SENT`, `SHRED_SUCCESS`).
  - Mints signed CoE on `SHRED_SUCCESS`.
- `GET /api/v1/certificates/:requestId`
  - Returns the signed certificate payload + signature.

## Testing

- Unit tests: Ed25519 CoE signing/verification (`api/tests/unit`).
- Integration tests: API + PostgreSQL state-machine flow (`api/tests/integration`).

Integration tests require a reachable PostgreSQL at `TEST_DATABASE_URL` (or default localhost DSN).
