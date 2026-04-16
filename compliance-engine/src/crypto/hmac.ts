/**
 * MODULE 1.2: HMAC PSEUDONYMIZATION
 * Pattern: HMAC-SHA256
 * 
 * Used for one-way masking of user identities. 
 * Allows the system to group records belonging to the same user 
 * without knowing who the user is.
 */

/**
 * Generates a SHA-256 HMAC for the given input using a salt.
 * We use a salt to prevent rainbow table attacks.
 * 
 * @param input The raw data to hash (e.g., User ID, Email)
 * @param salt A cryptographic salt unique to the user or application
 * @returns Hex string representation of the HMAC
 */
export async function generateHMAC(input: string, salt: string): Promise<string> {
  const crypto = globalThis.crypto;
  const encoder = new TextEncoder();
  
  // 1. Import the salt as the HMAC key
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  // 2. Sign the input data
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(input)
  );

  // 3. Convert the ArrayBuffer to a Hex String
  const hashArray = Array.from(new Uint8Array(signature));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return hashHex;
}
