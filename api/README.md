# Compliance API

This package is the control-plane scaffold for the broader compliance platform.

Its current purpose is to give the monorepo a stable home for the future central API described in the worker docs:

- job orchestration,
- worker sync endpoints,
- metadata coordination,
- and certificate generation.

For now it exposes a minimal Bun server so the package can be developed and typechecked inside the workspace without inventing the full API contract prematurely.

## Current Structure

- `src/modules/worker`
  Worker-facing control-plane module with controller/service/repository layering.
- `src/types`
  Shared API domain and JSON types used across multiple modules.
- `src/db`
  Postgres client and schema bootstrap/migrations for task queue + outbox.
- `tests/unit`
  Fast, isolated tests (no external dependencies).
- `tests/integration`
  Endpoint + DB tests for production-like behavior.

## Test Strategy

### Layman terms

- Unit tests check internal behavior quickly.
- Integration tests prove routes + database behavior actually works together.

### Technical terms

- `test:unit`: no network/database requirements; deterministic service/app checks.
- `test:integration`: exercises HTTP endpoints and SQL side effects.
- `test:all`: runs both suites in order.

```bash
bun run test:unit
bun run test:integration
bun run test:all
```

Integration tests require a reachable PostgreSQL instance (same requirement as before).
