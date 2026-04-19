Here is the definitive, legally compliant HTTP POST request structure your Control Plane must enforce.

This schema is engineered to satisfy the Digital Personal Data Protection (DPDP) Act 2023, the Prevention of Money Laundering Act (PMLA) 2002, and Information Technology (IT) Act Section 43A. By strictly enforcing this payload, your platform operates as a legally shielded Data Processor, pushing the burden of proof (identification and intent) back onto the client (the Data Fiduciary).

### The Ingestion Payload (`POST /api/v1/erasure-requests`)

Provide this exact JSON structure to your clients.

```json
{
  "subject_opaque_id": "usr_8847a92b_4f1c_882a",
  "idempotency_key": "req_550e8400-e29b-41d4-a716-446655440000",
  "trigger_source": "USER_CONSENT_WITHDRAWAL",
  "actor_opaque_id": "usr_8847a92b_4f1c_882a",
  "legal_framework": "DPDP_2023",
  "request_timestamp": "2026-04-19T10:00:00Z",

  "tenant_id": "org_reliance_retail_01",
  "cooldown_days": 30,
  "shadow_mode": false,
  "webhook_url": "https://api.client.in/webhooks/dpdp-receipts"
}
```

-----

### 🔴 Mandatory Fields (The Legal Shield)

If the client omits a single one of these fields, your Hono API must instantly reject the request with a `400 Bad Request`.

| Field | Type | What it Does | Why it is Legally & Architecturally Necessary |
| :--- | :--- | :--- | :--- |
| `subject_opaque_id` | `String` | Identifies the database row to be vaulted. | **DPDP Sec 6 (Data Minimization):** You must never ingest emails or phone numbers. If your Control Plane database is breached, the hackers only get meaningless strings. The client maintains the map of `usr_123` to `alice@email.com`. |
| `idempotency_key` | `UUID` / `String` | Prevents the creation of duplicate vaulting jobs if the client's network retries the request. | **IT Act Sec 43A (Security Practices):** Prevents replay attacks and database corruption. Ensures that a network glitch doesn't trigger two conflicting countdown timers. |
| `trigger_source` | `Enum` | Records *why* the data is being deleted. <br>*(e.g., `USER_CONSENT_WITHDRAWAL`, `PURPOSE_FULFILLED`, `ADMIN_PURGE`)* | **DPDP Sec 8(7):** A Data Fiduciary must erase data when consent is withdrawn OR when its specified purpose is no longer served. The auditor will demand to know which of these two triggered the event. |
| `actor_opaque_id` | `String` | Records the ID of the person who clicked "Delete". (Often matches `subject_opaque_id`, but differs if an Admin does it). | **DPDP Sec 8 (Accountability):** If a user claims they never deleted their account, this proves whether the user initiated it via the app, or a rogue customer support agent purged it manually. |
| `legal_framework` | `Enum` | Explicitly states the governing law under which this request is made. <br>*(e.g., `DPDP_2023`, `GDPR`)* | **Jurisdictional Binding:** Defines what legal text is printed on the final Certificate of Erasure. If a foreign national uses an Indian app, the client must specify if DPDP or GDPR rules apply to this specific execution. |
| `request_timestamp`| `ISO 8601` | The exact millisecond the client's backend received the user's request. | **DPDP Grievance SLAs:** Regulators track compliance based on when the user asked, not when your API processed it. This synchronizes your Engine's timeline with the client's audit logs. |

-----

### 🟡 Optional Fields (Client-Dependent Configuration)

These fields adapt your engine to the specific architecture and business logic of the client. Your API should apply safe defaults if these are omitted.

| Field | Type (Default) | What it Does | Why it is Necessary (When Used) |
| :--- | :--- | :--- | :--- |
| `tenant_id` | `String` <br>*(null)* | Scopes the Worker's database queries to a specific organization. | **Multi-Tenancy Isolation:** If your client is a B2B SaaS (like Zoho), multiple companies share the same database tables. The Worker *must* inject `AND tenant_id = 'X'` into its queries to prevent accidentally vaulting data belonging to a different company. Unnecessary for B2C apps (like Swiggy). |
| `cooldown_days` | `Integer` <br>*(30)* | The delay period managed by the Control Plane before the Worker physically executes the vaulting. | **DPDP Right to Withdraw Consent:** Gives the user a window to reverse their decision. If they restore their account, the client sends a `/cancel` request. |
| `shadow_mode` | `Boolean` <br>*(false)* | Instructs the Worker to execute the full graph traversal and encryption, but roll back the transaction at the end. | **Enterprise Integration Testing:** Allows new clients to test your sidecar on their production database without any risk of actual data mutation. Proves the logic works before they flip the switch. |
| `webhook_url` | `String` <br>*(null)* | An endpoint your Control Plane will POST to when the final `SHRED_SUCCESS` WORM log is verified. | **Asynchronous Operations:** 5 to 10 years from now, when the PMLA timer expires and the DEK is destroyed, the client's systems need to be notified automatically so they can update their internal compliance dashboards. |
