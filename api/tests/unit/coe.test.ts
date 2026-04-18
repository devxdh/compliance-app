import { describe, expect, it } from "vitest";
import { createEd25519Signer, verifyEd25519Signature } from "../../src/crypto/coe";

describe("CoE Cryptography", () => {
  it("signs and verifies deterministic certificate payloads", async () => {
    const signer = await createEd25519Signer("test-key");

    const payload = {
      requestId: "req_123",
      targetHash: "ab".repeat(32),
      shreddedAt: "2026-04-18T00:00:00.000Z",
      method: "CRYPTO_SHREDDING_DEK_DELETE",
      legalFramework: "DPDP_SEC_8_7",
    };

    const signature = await signer.sign(payload);
    const verified = await verifyEd25519Signature(
      signature.publicKeySpkiBase64,
      signature.signatureBase64,
      payload
    );

    expect(signature.algorithm).toBe("Ed25519");
    expect(signature.keyId).toBe("test-key");
    expect(verified).toBe(true);
  });
});
