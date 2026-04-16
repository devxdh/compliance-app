# Backlog

## Completed In This Iteration

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
