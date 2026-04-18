/**
 * MODULE 1: THE CRYPTOGRAPHIC CORE (THE SAFE)
 *
 * Layman Terms:
 * Imagine a titanium safe (AES-256). But what if a hacker sneaks in, can't open it, 
 * but hits it with a hammer to ruin what's inside? "GCM" is like a magical tamper-evident seal. 
 * When you try to open the safe later, the seal checks if anyone scratched the outside. 
 * If it detects tampering, the safe jams and refuses to open.
 *
 * Technical Terms:
 * Implements AES-256-GCM. GCM (Galois/Counter Mode) provides Authenticated Encryption 
 * with Associated Data (AEAD), guaranteeing both Confidentiality and Integrity. 
 * It appends a 16-byte Auth Tag to the ciphertext to instantly fail decryption if tampered with.
 */

import { fail } from "../errors";

const IV_LENGTH = 12; // 96-bit IV is the industry standard for GCM.
const KEY_LENGTH = 32; // 256-bit key for AES-256.

/**
 * Encrypts raw text using a 32-byte Data Encryption Key (DEK).
 * Returns a single Buffer: [IV (12B) + Ciphertext (Variable) + Tag (16B)]
 */
export async function encryptGCM(plaintext: string, rawKey: Uint8Array): Promise<Uint8Array> {
  if (rawKey.length !== KEY_LENGTH) {
    fail({
      code: "DPDP_CRYPTO_INVALID_KEY_LENGTH",
      title: "Invalid AES key length",
      detail: `Invalid key length. Expected ${KEY_LENGTH} bytes for AES-256, got ${rawKey.length} bytes.`,
      category: "crypto",
      retryable: false,
    });
  }

  const crypto = globalThis.crypto;

  // 1. Import the raw 32-byte key into a format the Web Crypto API understands.
  const key = await crypto.subtle.importKey(
    "raw",
    rawKey as any,
    "AES-GCM",
    false,
    ["encrypt"]
  );

  // 2. Generate a unique "Initialization Vector" (IV). 
  // CRITICAL: NEVER REUSE AN IV WITH THE SAME KEY.
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  // 3. Encrypt the data. 
  const encodedData = new TextEncoder().encode(plaintext);
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encodedData
  );

  // 4. Combine [IV + Ciphertext] into one result. 
  // The "Auth Tag" is automatically appended at the end of the ciphertext in Web Crypto.
  const combined = new Uint8Array(iv.length + ciphertextBuffer.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertextBuffer), iv.length);

  return combined;
}

/**
 * Decrypts a combined buffer [IV + Ciphertext + Tag] using the raw DEK.
 */
export async function decryptGCM(combined: Uint8Array, rawKey: Uint8Array): Promise<string> {
  if (rawKey.length !== KEY_LENGTH) {
    fail({
      code: "DPDP_CRYPTO_INVALID_KEY_LENGTH",
      title: "Invalid AES key length",
      detail: `Invalid key length. Expected ${KEY_LENGTH} bytes for AES-256, got ${rawKey.length} bytes.`,
      category: "crypto",
      retryable: false,
    });
  }

  if (combined.length < IV_LENGTH + 16) { // IV + Auth Tag (16 bytes)
    fail({
      code: "DPDP_CRYPTO_INVALID_CIPHERTEXT",
      title: "Invalid ciphertext",
      detail: "Invalid ciphertext. Too short to be a valid AES-GCM payload.",
      category: "crypto",
      retryable: false,
    });
  }

  const crypto = globalThis.crypto;

  // 1. Extract the IV (first 12 bytes) and the actual ciphertext (everything else).
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  // 2. Import the key.
  const key = await crypto.subtle.importKey(
    "raw",
    rawKey as any,
    "AES-GCM",
    false,
    ["decrypt"]
  );

  // 3. Decrypt. If the data was tampered with, this will throw an error automatically.
  let decryptedBuffer: ArrayBuffer;
  try {
    decryptedBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
  } catch (error) {
    fail({
      code: "DPDP_CRYPTO_INTEGRITY_FAILURE",
      title: "AES-GCM integrity verification failed",
      detail: "Decryption failed because the ciphertext or auth tag was corrupted.",
      category: "crypto",
      retryable: false,
      cause: error,
    });
  }

  return new TextDecoder().decode(decryptedBuffer);
}
