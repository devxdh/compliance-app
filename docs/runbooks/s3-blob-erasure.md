# S3 Blob Erasure Runbook

Use this runbook when a tenant enables `blob_targets` for document, image, or KYC object storage.

## Preconditions
- S3 buckets must have **Versioning** enabled for the `versioned_hard_delete` action.
- Buckets using Legal Hold must have **S3 Object Lock** enabled.
- The worker IAM role requires: `s3:HeadObject`, `s3:PutObjectLegalHold`, `s3:ListBucketVersions`, `s3:DeleteObjectVersion`, and `s3:PutObject` (for overwrites).
- For Governance-mode buckets, the worker requires `s3:BypassGovernanceRetention`.

## Vault Failure (Stage 1)
1.  **Check Error Code:** `DPDP_BLOB_URL_INVALID` indicates the database column contains a malformed URL.
2.  **S3 Accessibility:** `DPDP_S3_OPERATION_REJECTED (403)` indicates the worker IAM role lacks permission to apply the Legal Hold or Put a sanitized placeholder.
3.  **Owner Verification:** `expected_bucket_owner` must match the AWS Account ID of the client to prevent confused-deputy attacks.

## Shred Failure (Stage 3)
1.  **Identity Conflict:** `DPDP_BLOB_SHARED_OBJECT_CONFLICT` occurs if the same S3 object is referenced by another user who hasn't been shredded yet. The worker will refuse to delete the file to prevent data loss for the active user.
2.  **Version Proliferation:** If a bucket has millions of versions, `ListObjectVersions` may time out. Increase the worker's `timeoutMs` or manually prune old delete markers.
3.  **Purge Verification:** Confirm `shred_status` in `dpdp_engine.blob_objects`.
    *   `purged`: Every version was deleted.
    *   `retained_by_policy`: The object was kept under Legal Hold (action: `legal_hold_only`).

## Audit Protocol
- **Privacy:** Raw bucket names and keys never leave the client VPC.
- **Verification:** The `SHRED_SUCCESS` outbox event contains HMACed object reference hashes. These can be compared against the DPO's local `blob_objects` table during a forensic audit.
