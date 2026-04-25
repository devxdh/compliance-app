# Deployment Assets

## Local stack
- `docker-compose.yml` brings up Postgres, API, worker, Prometheus, Alertmanager, Grafana, and a local mail/webhook sink.
- `bun run local:e2e` renders the local worker config, boots the stack, submits an erasure request, waits for a certificate, verifies mail delivery, and tears the stack down.

## Kubernetes
- `deploy/k8s/base` contains the least-privilege baseline manifests.
- The manifests assume an external Postgres service and Vault Secrets Store CSI for secret delivery.
- Replace placeholder images before deployment.
- The namespace enables Kubernetes `restricted` Pod Security admission labels. Keep `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, and dropped Linux capabilities intact unless a security review approves an exception.
- Production API manifests enforce the shadow-mode burn-in gate with `SHADOW_BURN_IN_REQUIRED=true` and `SHADOW_REQUIRED_SUCCESSES=100`. The local compose stack disables it only so the deterministic E2E smoke test can execute one live mutation.

## Secret handling
- The code supports both direct env vars and `_FILE` companions.
- For Kubernetes, prefer CSI-mounted files over plain env values.
- The worker can also resolve `security.master_key_source` and `security.hmac_key_source` from native runtime providers:
  - `aws_kms`: calls AWS KMS `Decrypt` using Web Crypto SigV4 signing and expects a 32-byte plaintext key.
  - `gcp_secret_manager`: calls Secret Manager `versions.access` and decodes `payload.data`.
  - `hashicorp_vault`: calls Vault KV v2 at `/:mount/data/:path` and reads the configured field.
- Remote key providers are resolved at worker boot via `readWorkerConfigFromRuntime`; the synchronous config reader is intentionally limited to env/file sources for tests and local tooling.

## S3 blob erasure
- `blob_targets` in `compliance.worker.yml` extend the erasure boundary to PII-bearing object URLs such as KYC scans or invoice PDFs.
- The worker uses native SigV4 signing and the local AWS credential chain only; the AWS SDK is intentionally not part of the runtime.
- Supported credential paths are static `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, ECS task credentials, and EC2 IMDSv2. In production, prefer task or instance roles scoped to only the configured buckets and actions.
- Required IAM actions depend on the chosen blob action: `s3:HeadObject`, `s3:PutObjectLegalHold`, `s3:ListBucketVersions`, `s3:DeleteObjectVersion`, and optionally `s3:PutObject` for sanitized overwrite.
- Raw S3 bucket/key/version coordinates are stored only in the worker-local `dpdp_engine.blob_objects` table. Control Plane outbox events receive HMACed object references and counts, not raw paths.
- Buckets using `versioned_hard_delete` must have versioning enabled. Buckets using Legal Hold must have S3 Object Lock enabled before objects are created.

## Schema and FK safety
- The worker now fails closed if graph traversal finds `ON DELETE CASCADE`, `ON DELETE SET NULL`, or `ON DELETE SET DEFAULT` below the root table. Those actions can mutate dependent rows outside the explicit vault/redaction plan.
- Client schemas should use `NO ACTION`/`RESTRICT` FKs for data under erasure control, then let the worker perform explicit satellite chunking or hard-delete steps.
