/**
 * Computes deterministic HMAC-SHA256 for worker pseudonymization and lookup keys.
 *
 * @param input - Plain input string to sign.
 * @param salt - HMAC key material (salt/secret).
 * @returns Lowercase hex digest.
 */
export async function generateHMAC(input: string, salt: string): Promise<string> {
  const crypto = globalThis.crypto;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(input)
  );

  const hashArray = Array.from(new Uint8Array(signature));
  const hashHex = hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return hashHex;
}
