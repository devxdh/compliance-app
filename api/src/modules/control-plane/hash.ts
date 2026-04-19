/**
 * Computes a SHA-256 hex digest for the WORM audit chain.
 */
export async function computeWormHash(previousHash: string, payload: unknown, idempotencyKey: string): Promise<string> {
  const data = new TextEncoder().encode(`${previousHash}${JSON.stringify(payload)}${idempotencyKey}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("hex");
}

/**
 * Computes a SHA-256 hex digest for worker API token storage.
 */
export async function computeTokenHash(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("hex");
}
