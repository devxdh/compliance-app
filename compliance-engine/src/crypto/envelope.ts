/**
 * Envelope-encryption helpers for KEK/DEK key management.
 */

import { encryptGCM, decryptGCM } from "./aes";
import { base64ToBytes, bytesToBase64 } from "../utils/encoding";

const KEY_SIZE = 32; // 256-bit keys

/**
 * Generates a new random 32-byte data-encryption key.
 *
 * @returns Cryptographically secure DEK bytes.
 */
export function generateDEK(): Uint8Array {
  const crypto = globalThis.crypto;
  return crypto.getRandomValues(new Uint8Array(KEY_SIZE));
}

/**
 * Wraps a DEK with the worker KEK.
 *
 * @param dek - Plain DEK bytes.
 * @param kek - 32-byte KEK bytes.
 * @returns Encrypted DEK blob.
 */
export async function wrapKey(dek: Uint8Array, kek: Uint8Array): Promise<Uint8Array> {
  const encryptedKey = await encryptGCM(bytesToBase64(dek), kek);
  return encryptedKey;
}

/**
 * Unwraps a previously wrapped DEK with the worker KEK.
 *
 * @param wrappedKey - Encrypted DEK blob.
 * @param kek - 32-byte KEK bytes.
 * @returns Plain DEK bytes.
 */
export async function unwrapKey(wrappedKey: Uint8Array, kek: Uint8Array): Promise<Uint8Array> {
  const decryptedBase64 = await decryptGCM(wrappedKey, kek);
  return base64ToBytes(decryptedBase64);
}
