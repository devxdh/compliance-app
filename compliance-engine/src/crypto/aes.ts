/**
 * MODULE 1: THE CRYPTOGRAPHIC CORE (THE SAFE)
 * Standard: AES-256-GCM (Authenticated Encryption)
 * 
 * Why GCM? Unlike older modes, GCM provides "Integrity." 
 * If a hacker tries to modify the encrypted data (even by 1 bit), 
 * the decryption will fail immediately.
 */

const IV_LENGTH = 12; // 96-bit IV is the industry standard for GCM.
const KEY_LENGTH = 32; // 256-bit key for AES-256.

/**
 * Encrypts raw text using a 32-byte Data Encryption Key (DEK).
 * Returns a single Buffer: [IV (12B) + Ciphertext (Variable) + Tag (16B)]
 */
export async function encryptGCM(plaintext: string, rawKey: Uint8Array): Promise<Uint8Array> {
  if (rawKey.length !== KEY_LENGTH) {
    throw new Error(`Invalid key length. Expected ${KEY_LENGTH} bytes for AES-256, got ${rawKey.length} bytes.`);
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
    throw new Error(`Invalid key length. Expected ${KEY_LENGTH} bytes for AES-256, got ${rawKey.length} bytes.`);
  }

  if (combined.length < IV_LENGTH + 16) { // IV + Auth Tag (16 bytes)
    throw new Error("Invalid ciphertext. Too short to be a valid AES-GCM payload.");
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
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(decryptedBuffer);
}
