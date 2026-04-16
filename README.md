# Compliance App Monorepo

This repository is now the root workspace for the compliance platform.

It keeps the existing `compliance-engine` worker package intact and adds a sibling `api` package for the control-plane side described in the engine docs.

## Workspace Layout

- `api/`
  Bun + TypeScript control-plane package scaffold for the future central API.
- `compliance-engine/`
  Existing zero-trust worker/data-plane package. Its source, tests, and docs remain in place.

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
bun run engine:test
bun run engine:test-ui
bun run engine:typecheck
bun run typecheck
bun run test
bun run check
```

`bun run test` executes the worker test suite from `compliance-engine/`, so a reachable PostgreSQL instance is still required for the integration-heavy engine tests.

The API scaffold defaults to port `3000`; override `PORT` if that port is already occupied in your local environment.

## Notes

- `compliance-engine` stays at the same path to avoid breaking the existing worker codebase.
- The `api` package is intentionally minimal for now; it establishes the monorepo boundary without guessing the full control-plane implementation.
- The engine package still owns its domain-specific docs under `compliance-engine/docs/`.
