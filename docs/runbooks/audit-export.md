# Audit Export And Archival

## Local export
- Use `GET /api/v1/admin/audit/export` with the admin token.
- The endpoint emits newline-delimited JSON for immutable downstream archival.

## Recommended archival flow
1. Pull NDJSON on a schedule.
2. Compute a SHA-256 manifest over the exported file.
3. Write both the NDJSON and the manifest to immutable object storage with retention lock enabled.
4. Replicate to a second region or account.

## Minimum metadata to preserve
- `worker_idempotency_key`
- `event_type`
- `previous_hash`
- `current_hash`
- export timestamp
- archival manifest hash

