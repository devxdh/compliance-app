/**
 * MODULE 1.1: ENVELOPE ENCRYPTION (THE VAULT)
 * Pattern: KEK (Key Encrypting Key) / DEK (Data Encrypting Key)
 * 
 * The KEK lives ONLY in RAM (Master Key from Env). 
 * The DEK is used to encrypt user data and is itself encrypted by the KEK.
 */

import { encryptGCM, decryptGCM } from "./aes";

const KEY_SIZE = 32; // 256-bit keys

/**
 * Generates a random, cryptographically secure 32-byte key (DEK).
 */
export function generateDEK(): Uint8Array {
  const crypto = globalThis.crypto;
  return crypto.getRandomValues(new Uint8Array(KEY_SIZE));
}

/**
 * Wraps (encrypts) a Data Encryption Key using the Master KEK.
 */
export async function wrapKey(dek: Uint8Array, kek: Uint8Array): Promise<Uint8Array> {
  // We reuse our AES-GCM module to encrypt the key itself.
  const encryptedKey = await encryptGCM(
    Buffer.from(dek).toString("base64"), // Convert DEK to base64 for reliable string handling
    kek
  );
  return encryptedKey;
}

/**
 * Unwraps (decrypts) a Data Encryption Key using the Master KEK.
 */
export async function unwrapKey(wrappedKey: Uint8Array, kek: Uint8Array): Promise<Uint8Array> {
  const decryptedBase64 = await decryptGCM(wrappedKey, kek);
  return new Uint8Array(Buffer.from(decryptedBase64, "base64"));
}
