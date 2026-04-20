const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );
}

/**
 * Computes the canonical worker/API HMAC request signature.
 *
 * @param secret - Shared HMAC secret.
 * @param method - HTTP method.
 * @param path - URL pathname.
 * @param clientId - Worker client identifier.
 * @param timestamp - Unix epoch milliseconds string.
 * @param bodyText - Exact request body text.
 * @returns Lowercase hex digest.
 */
export async function computeRequestSignature(
  secret: string,
  method: string,
  path: string,
  clientId: string,
  timestamp: string,
  bodyText: string
): Promise<string> {
  const key = await importSigningKey(secret);
  const payload = textEncoder.encode(
    [method.toUpperCase(), path, clientId, timestamp, bodyText].join("\n")
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, payload);
  return bytesToHex(new Uint8Array(signature));
}
