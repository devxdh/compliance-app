# Software Requirements Specification

## Goal

Build a worker that runs inside a client's environment and handles the local, sensitive half of the compliance workflow:

- pseudonymize user-facing records,
- vault raw PII locally,
- notify users before final anonymization,
- crypto-shred the vault when retention expires,
- apply configured S3 legal hold/purge actions,
- and synchronize metadata out through a durable outbox.

## Functional Requirements

1. The worker must provision its own PostgreSQL schema.
2. The worker must encrypt raw PII with per-user DEKs and wrap those DEKs with a KEK.
3. The worker must generate stable, non-plain-text worker hashes for local tracking.
4. The worker must discover dependent tables through a recursive Postgres graph traversal.
5. The worker must hard delete immediately when the root table has no dependent tables.
6. The worker must record outbound API events transactionally with the primary mutation.
7. The worker must support a dry-run mode for vault, notice, and shred operations.
8. The worker must send a pre-erasure notice only inside the allowed time window.
9. The worker must prevent duplicate notice sends under concurrent execution.
10. The worker must refuse shredding before retention expiry.
11. The worker must require a sent notice before shredding unless an operator overrides that behavior.
12. The worker must retry outbox delivery failures with backoff and dead-letter handling.
13. The worker must compute a Tamper-Evident Outbox hash sequence to guarantee append-only immutability.
14. The worker must perform Schema Drift Detection at boot to guarantee the data integrity footprint matches its declarative configuration.
15. The worker must refuse to boot without DPO legal attestation and rule-level legal citations.
16. The worker must evaluate all configured evidence rules and choose the longest applicable retention period.
17. The worker must fail closed on unsafe FK cascade/set-null actions.
18. The worker must process satellite tables in bounded `FOR UPDATE SKIP LOCKED` chunks.
19. The worker must support configured S3 blob legal hold and version-aware purge operations.
20. The worker must expose health, readiness, and Prometheus metrics endpoints.

## Non-Functional Requirements

- Fail closed on invalid configuration, invalid identifiers, or incomplete dependency traversal.
- Keep raw PII inside the client network.
- Be deterministic and testable with injected clocks and transports.
- Support idempotent replay of operational commands.
- Preserve enough non-PII metadata locally for auditability after shredding.
- Wipe plaintext and key buffers after cryptographic use.
- Avoid legacy `node:crypto`; use native Web Crypto.
- Avoid ORMs; use `postgres.js` only.
- Use Postgres time math for legal retention deadlines.

## Dependencies

- PostgreSQL
- TypeScript
- `postgres.js`
- Vitest
- Bun
- Web Crypto APIs
- Native `fetch`
