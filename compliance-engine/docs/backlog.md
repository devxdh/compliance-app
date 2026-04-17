# Backlog

## Completed In This Iteration

- **Implement Phase 1 Hardening: Liability Shield & Scale Engine**
  - **Tamper-Evident Outbox (Hash Chaining):** Modified the `outbox` table to include `previous_hash` and `current_hash`. Re-wrote `enqueueOutboxEvent` to natively compute sequential SHA-256 hashes (`previous_hash + payload + idempotency_key`) using Web Crypto, providing a cryptographically verifiable chain of events. 
  - **Schema Drift Detection:** Added a `detectSchemaDrift` utility that queries `information_schema.columns` to compute a deterministic hash of the target database schema structure.
  - **Fail-Fast Startup Guard:** Updated the boot sequence (`src/index.ts`) to immediately throw a fatal error (`exit(1)`) if the computed live schema hash does not strictly match the `expected_schema_hash` declared in the declarative configuration (`compliance.worker.yml`).
  - **Declarative YAML Configuration:** Swapped explicit `process.env` lookups for a `yaml` based `compliance.worker.yml` parsed strictly at boot. Kept secrets in `process.env` referenced dynamically via keys defined in YAML to ensure proper cryptographic segregation.
- Replace placeholder pseudonymization with HMAC-backed worker hashing and pseudonyms.
- Add validated worker configuration parsing.
- Parameterize engine schema usage for cleaner test isolation.
- Add durable notice and shred metadata to the worker schema.
- Add outbox leases, retry counts, backoff scheduling, and dead-letter state.
- Add dry-run support to vault, notice, and shred operations.
- Add tests for config validation, graph fail-closed behavior, idempotent vaulting, notice failure recovery, shred fail-safes, and outbox retries.
- Expand README and architecture docs.

## Recommended Next Steps

- Add a worker runtime entrypoint that reads `WorkerConfig` and wires mail/API transports directly.
- Add structured logging and metrics emission around each stage transition.
- Add integration coverage for real HTTP dispatch via `createFetchDispatcher`.
- Add container/runtime packaging for deployment inside a distroless image.
- Add explicit operator tooling for listing dead-letter events and requeueing them safely.
