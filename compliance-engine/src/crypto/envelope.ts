/**
 * MODULE 1.1: ENVELOPE ENCRYPTION (THE VAULT)
 * 
 * Layman Terms:
 * The Master Safe. Imagine millions of titanium safes. If you store the keys next to them, 
 * a thief gets everything. Instead, you put all the millions of smaller keys inside one Master Safe. 
 * The combination to the Master Safe is in your brain. If hackers steal the warehouse (database), 
 * they just get locked safes and locked keys. Because the Master Combination is in your brain 
 * (server RAM), they get nothing.
 *
 * Technical Terms:
 * Implements the Two-Tier KEK/DEK Architecture.
 * KEK (Key Encrypting Key) lives only in RAM (via Env Variables).
 * DEK (Data Encrypting Key) is a unique per-user key generated and then encrypted by the KEK 
 * before persistence. This isolates symmetric keys from the database, enabling $O(1)$ crypto-shredding.
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
