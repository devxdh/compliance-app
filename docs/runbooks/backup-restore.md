# Backup And Restore

## Scope
- Control Plane schema: `dpdp_control`
- Worker engine schema: `dpdp_engine`
- Client application schema: owned by the tenant, not by this project

## Backup policy
- Enable WAL archiving on the managed Postgres cluster.
- Take daily physical backups plus point-in-time recovery.
- Retain backups for at least the maximum legal retention horizon plus your incident response window.
- Test restores at least once per sprint in a non-production environment.

## Restore sequence
1. Restore Postgres to an isolated instance at the requested recovery point.
2. Start only the API with worker replicas scaled to `0`.
3. Validate `audit_ledger`, `certificates`, `erasure_jobs`, `task_queue`, `pii_vault`, and `outbox` row counts.
4. Verify the latest audit ledger chain head for every tenant before resuming workers.
5. Re-render the worker config if the application schema changed and confirm the expected schema hash.
6. Scale worker replicas up one at a time.

## Do not do
- Do not restore production backups into a shared developer environment.
- Do not resume workers until the audit chain and schema integrity checks pass.
- Do not truncate `dead_letter` state rows during incident response.

