# Schema Drift Response

## Trigger
- Worker boot fails with `DPDP_SCHEMA_DRIFT_DETECTED`.

## Response
1. Stop the worker rollout. Do not bypass the integrity check.
2. Diff the live tenant schema against the last approved application schema.
3. If the change is expected, compute the new schema hash and update the signed worker config.
4. If the change is unexpected, escalate to the tenant owner and freeze erasure execution for that tenant.
5. Re-run worker startup in a staging clone before production rollout.

## Compute a new hash
- Use `bun run scripts/render-local-worker-config.ts` only for local validation.
- In production, compute the hash through the same `detectSchemaDrift()` logic and update the signed config release.

