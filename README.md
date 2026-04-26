# Avantii Compliance App Monorepo

This repository contains the current implementation of Avantii: a two-plane DPDP/PMLA erasure compliance platform for Indian data fiduciaries and their processors.

The product has three deployable surfaces:

- `api/`: the metadata-only Control Plane.
- `compliance-engine/`: the in-VPC Worker Sidecar that performs local data mutation.
- `web/`: the operator dashboard and BFF that talks to the Control Plane using a server-side admin token.

## Workspace Layout

- `api/`
  Bun + Hono Control Plane for metadata-only erasure orchestration, task leasing, WORM ledger ingestion, Certificates of Erasure, admin recovery, usage accounting, and shadow burn-in enforcement.
- `compliance-engine/`
  Bun + TypeScript Worker Sidecar for in-VPC graph traversal, evidence-based retention, cryptographic vaulting, notification, shredding, S3 blob erasure, outbox relay, and metrics.
- `web/`
  Next.js App Router dashboard with Auth.js, server-only Control Plane calls, client management, job monitoring, WORM ledger export, DLQ recovery, and certificate download links.
- `deploy/`
  Docker Compose, Kubernetes, Prometheus, Grafana, Alertmanager, and local E2E assets.

## Tooling Decisions

- **Package manager:** Bun workspaces
- **Language:** TypeScript across packages
- **Shared config:** root `tsconfig.base.json`
- **Verification entrypoint:** root `package.json` scripts

The root package intentionally keeps dependency versions centralized through Bun catalogs while leaving each workspace package self-contained.

## Root Scripts

```bash
bun run api:dev
bun run api:start
bun run api:typecheck
bun run api:test
bun run engine:test
bun run engine:test-ui
bun run engine:typecheck
bun run web:dev
bun run web:build
bun run web:typecheck
bun run web:test
bun run local:e2e
bun run typecheck
bun run test
bun run check
```

`bun run test` runs the API, worker, and Playwright web smoke suites. API and worker tests require a reachable PostgreSQL instance through `TEST_DATABASE_URL` or the default local DSN. Playwright also requires browser system dependencies on the host.

`bun run check` runs type checks, API tests, worker tests, and a production web build. Use `bun run local:e2e` for the Docker Compose smoke path across API, worker, database, mock mail/webhook sink, and certificate creation.

## Architecture Rules

- Raw PII must never leave the client's VPC.
- API and web Control Plane surfaces must stay metadata-only.
- Dynamic SQL must use `postgres.js` identifier interpolation, never string concatenation.
- Cryptography must use `globalThis.crypto`; `node:crypto` is not used.
- Time math for future legal deadlines must be done in Postgres, not JavaScript.
- Prisma/TypeORM/Sequelize are intentionally not used.

## Documentation Map

- [Architecture](docs/ARCHITECTURE.md): master system model and data flow.
- [Decisions](docs/DECISIONS.md): hard architectural decisions and their rationale.
- [Current Status](docs/PROJECT_STATUS.md): what is implemented, verified, and deferred.
- [Ship Readiness](docs/SHIP_READINESS.md): founder-facing checklist before a paid DPDP launch.
- [Full Architecture Guide](docs/full-architecture/project.md): lifecycle narrative and diagrams.
- [Deployment](deploy/README.md): local and Kubernetes deployment notes.
