# Enterprise Request Contract

This document describes the current Control Plane ingestion contract. It is the external payload a client backend sends when a Data Principal requests erasure or when a DPO/admin triggers a purge.

The endpoint is metadata-only:

```http
POST /api/v1/erasure-requests
Content-Type: application/json
```

```json
{
  "subject_opaque_id": "usr_8847a92b_4f1c_882a",
  "idempotency_key": "550e8400-e29b-41d4-a716-446655440000",
  "trigger_source": "USER_CONSENT_WITHDRAWAL",
  "actor_opaque_id": "usr_8847a92b_4f1c_882a",
  "legal_framework": "DPDP_2023",
  "request_timestamp": "2026-04-19T10:00:00.000Z",
  "tenant_id": "org_client_01",
  "cooldown_days": 30,
  "shadow_mode": false,
  "webhook_url": "https://api.client.in/webhooks/dpdp-receipts"
}
```

## Required Fields

| Field | Type | Purpose |
| --- | --- | --- |
| `subject_opaque_id` | non-empty string | Client-owned opaque identifier for the subject. It must not be an email, phone number, Aadhaar number, PAN, or other raw PII. |
| `idempotency_key` | UUID string | Prevents duplicate cooldown timers and replayed erasure requests. |
| `trigger_source` | enum | One of `USER_CONSENT_WITHDRAWAL`, `PURPOSE_FULFILLED`, or `ADMIN_PURGE`. |
| `actor_opaque_id` | non-empty string | Opaque identifier for the actor who initiated the request. |
| `legal_framework` | string | Governing framework printed into the Certificate of Erasure, for example `DPDP_2023` or `PMLA`. |
| `request_timestamp` | ISO 8601 datetime | Time the client backend received the request. |

The API rejects undeclared fields such as `email`, `phone`, `full_name`, and other raw PII by using strict Zod schemas plus additional Zero-PII validation.

## Optional Fields

| Field | Default | Purpose |
| --- | --- | --- |
| `tenant_id` | `null` | Scopes worker-side evidence checks for multi-tenant client databases. |
| `cooldown_days` | `30` | Delay before `VAULT_USER` becomes eligible. The API computes `vault_due_at` in Postgres with `MAKE_INTERVAL`. |
| `shadow_mode` | `false` | Runs the worker pipeline and rolls back local mutations. The Control Plane can require 100 shadow successes before live mutation. |
| `webhook_url` | `null` | Client callback URL for terminal completion. The API validates URL shape and dispatches terminal events through durable webhook finalization. |

## Cancellation Contract

```http
POST /api/v1/erasure-requests/:idempotency_key/cancel
```

Cancellation only applies while the job is still in `WAITING_COOLDOWN`. The API also prevents cancelled jobs from being synced to workers.

## Worker Sync Contract

Workers call:

```http
GET /api/v1/worker/sync
x-client-id: <client-uuid-or-name>
authorization: Bearer <worker-token>
x-worker-config-hash: <sha256-of-active-yaml>
x-worker-config-version: <legal_attestation.configuration_version>
x-worker-dpo-identifier: <legal_attestation.dpo_identifier>
```

The API materializes due tasks and leases the next task with `FOR UPDATE SKIP LOCKED`. It only dispatches tasks whose legal due time has arrived and whose parent job is not `CANCELLED`.
