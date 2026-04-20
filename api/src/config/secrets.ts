import { readFileSync } from "node:fs";

/**
 * Resolves a string secret from either a direct environment value or a mounted secret file path.
 *
 * File-backed resolution is intended for Kubernetes secret volumes, CSI drivers, and Vault agent
 * injection workflows where plaintext values should not be committed to `.env` files.
 *
 * @param directValue - Secret value provided directly via environment variable.
 * @param filePath - Optional file containing the secret value.
 * @returns Resolved secret string or `undefined` when neither source is configured.
 */
export function readSecretString(
  directValue?: string,
  filePath?: string
): string | undefined {
  if (directValue && directValue.trim().length > 0) {
    return directValue.trim();
  }

  if (!filePath || filePath.trim().length === 0) {
    return undefined;
  }

  return readFileSync(filePath, "utf8").trim();
}
