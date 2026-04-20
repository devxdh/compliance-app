# Dead Letter Recovery

## Control Plane task DLQ
1. List dead-letter tasks from `GET /api/v1/admin/tasks/dead-letters`.
2. Inspect the persisted `error_text` and the parent `erasure_job` state.
3. Fix the root cause first: schema mismatch, credentials, request-signing drift, or malformed config.
4. Requeue only the specific task with `POST /api/v1/admin/tasks/:taskId/requeue`.
5. Watch the worker logs and confirm the task transitions back to `COMPLETED`.

## Worker outbox DLQ
1. Inspect `dpdp_engine.outbox` rows where `status = 'dead_letter'`.
2. Confirm whether the failure is protocol, authentication, or permanent payload drift.
3. Never modify `current_hash` or `previous_hash` in place.
4. If the event is still valid, move the row back to `pending`, clear lease fields, and reset `next_attempt_at`.
5. If the event is invalid, preserve it for audit and open an incident record.

## Exit criteria
- The task or event reaches a terminal success state.
- Root cause is documented.
- Any secret rotation or config change is reflected in the runbook change log.

