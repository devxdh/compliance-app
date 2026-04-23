# Project Visuals

This folder contains the visual companion set for
[complete-project.md](./project.md).

Each file is intentionally focused on one concern so the diagrams stay readable:

- [01-system-context.md](./visuals/01-system-context.md)
  Trust boundaries, deployed components, and the no-PII egress contract.
- [02-end-to-end-sequence.md](./visuals/02-end-to-end-sequence.md)
  Full cross-plane request lifecycle from ingestion to certificate issuance.
- [03-control-plane-state-machine.md](./visuals/03-control-plane-state-machine.md)
  `erasure_jobs` state transitions and terminal paths.
- [04-worker-execution-branches.md](./visuals/04-worker-execution-branches.md)
  Vault, hard-delete, notice, and shred execution branches inside the worker.
- [05-fail-safe-retry-flows.md](./visuals/05-fail-safe-retry-flows.md)
  Task leasing, retry, dead-letter, outbox delivery, and replay-safe recovery.

All diagrams describe the system as it exists in this repository today.
They do not assume a first-party UI, mTLS, or an external KMS service because those are not implemented in the current codebase.
