# S3 Blob Erasure Runbook

Use this runbook when a tenant enables `blob_targets` for document, image, or KYC object storage.

## Preconditions
- S3 buckets used with Legal Hold have Object Lock enabled before objects are written.
- Buckets used with `versioned_hard_delete` have versioning enabled.
- The worker IAM role is scoped to the configured bucket prefixes only.
- Required permissions are granted only as needed: `s3:HeadObject`, `s3:PutObjectLegalHold`, `s3:ListBucketVersions`, `s3:DeleteObjectVersion`, and optionally `s3:PutObject` for sanitized overwrite.
- `expected_bucket_owner` is set in production configs to prevent confused-deputy writes to a lookalike bucket.

## Vault failure
1. Inspect worker logs for `DPDP_BLOB_*` error codes.
2. Confirm the object URL parses as `s3://bucket/key?versionId=...` or an S3 HTTPS URL.
3. If `DPDP_BLOB_VERSION_ID_MISSING` occurs, verify the bucket returns `x-amz-version-id` from `HeadObject` or set `require_version_id: false` only with a written legal exception.
4. Do not manually mask the database URL unless the legal hold state is verified in S3.

## Shred failure
1. Query `dpdp_engine.blob_objects` for the subject hash and confirm `shred_status`.
2. If deletion fails with access denied, verify the role has `s3:DeleteObjectVersion` and, for governance mode, permission to bypass governance retention.
3. If `DPDP_BLOB_SHARED_OBJECT_CONFLICT` occurs, the same object is still referenced by another unshredded subject. Do not force delete; remediate the duplicate reference first.
4. After remediation, replay the `SHRED_USER` task from the Control Plane task DLQ or requeue the local worker outbox event if shredding already completed.

## Audit rules
- Raw bucket names, keys, and URLs remain inside the worker database only.
- Control Plane receipts contain HMACed object references and HMACed version identifiers.
- A `legal_hold_only` receipt means the object was retained by declared policy, not erased.
