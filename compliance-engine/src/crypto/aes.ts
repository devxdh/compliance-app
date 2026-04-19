/**
 * AES-256-GCM helpers built on the Web Crypto API.
 *
 * Payload layout is `IV(12 bytes) || ciphertext+tag`.
 */

import { fail } from "../errors";

const IV_LENGTH = 12; // 96-bit IV is the industry standard for GCM.
const KEY_LENGTH = 32; // 256-bit key for AES-256.

/**
 * Encrypts UTF-8 plaintext using AES-256-GCM.
 *
 * @param plaintext - Text payload to encrypt.
 * @param rawKey - 32-byte symmetric key.
 * @returns Combined buffer in `IV || ciphertext+tag` format.
 * @throws {WorkerError} When key length is invalid.
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

  const key = await crypto.subtle.importKey(
    "raw",
    rawKey as any,
    "AES-GCM",
    false,
    ["encrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const encodedData = new TextEncoder().encode(plaintext);
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encodedData
  );

  const combined = new Uint8Array(iv.length + ciphertextBuffer.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertextBuffer), iv.length);

  return combined;
}

/**
 * Decrypts a buffer in `IV || ciphertext+tag` format.
 *
 * @param combined - Combined encrypted payload produced by `encryptGCM`.
 * @param rawKey - 32-byte symmetric key.
 * @returns Decrypted UTF-8 plaintext.
 * @throws {WorkerError} When key/ciphertext is invalid or integrity verification fails.
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

  if (combined.length < IV_LENGTH + 16) {
    fail({
      code: "DPDP_CRYPTO_INVALID_CIPHERTEXT",
      title: "Invalid ciphertext",
      detail: "Invalid ciphertext. Too short to be a valid AES-GCM payload.",
      category: "crypto",
      retryable: false,
    });
  }

  const crypto = globalThis.crypto;

  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const key = await crypto.subtle.importKey(
    "raw",
    rawKey as any,
    "AES-GCM",
    false,
    ["decrypt"]
  );

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
