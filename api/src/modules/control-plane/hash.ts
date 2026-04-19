/**
 * Computes a SHA-256 hex digest for the WORM audit chain.
 *
 * @param previousHash - Prior chain hash or `GENESIS`.
 * @param payload - Event payload body.
 * @param idempotencyKey - Worker idempotency key.
 * @returns Chain hash for the current event.
 */
export async function computeWormHash(previousHash: string, payload: unknown, idempotencyKey: string): Promise<string> {
  const data = new TextEncoder().encode(`${previousHash}${JSON.stringify(payload)}${idempotencyKey}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("hex");
}

/**
 * Computes a SHA-256 hex digest for worker API token storage.
 *
 * @param token - Raw worker bearer token.
 * @returns SHA-256 token digest in hex format.
 */
export async function computeTokenHash(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("hex");
}
