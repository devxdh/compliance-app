# Key Rotation

## Worker secrets
- Rotate `DPDP_MASTER_KEY` and `DPDP_HMAC_KEY` through Vault or your external secret store.
- Mount new values through `_FILE` paths.
- Restart worker pods one replica at a time.
- Validate that new vault operations succeed before draining old replicas.

## Control Plane worker auth
- Use `POST /api/v1/admin/clients/:name/rotate-key` to mint a new bearer token and `current_key_id`.
- Update the worker secret store entry.
- Restart the worker.
- Confirm `last_authenticated_at` updates with the new key before disabling the old one.

## Certificate signing keys
- Generate a new Ed25519 keypair.
- Publish the new public key to verifiers before rollout.
- Mount the new `COE_PRIVATE_KEY_PKCS8_BASE64_FILE` and `COE_PUBLIC_KEY_SPKI_BASE64_FILE`.
- Update `COE_KEY_ID` to a new immutable version.
- Keep old public keys available for historical certificate verification.

