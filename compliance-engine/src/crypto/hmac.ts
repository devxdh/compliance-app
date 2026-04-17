/**
 * MODULE 1.2: HMAC PSEUDONYMIZATION
 *
 * Layman Terms:
 * The One-Way Meat Grinder. You put a steak in ("John Doe"), turn the handle, and out comes 
 * ground beef ("A8F9B2..."). You can never shove the ground beef back through to get the steak back. 
 * If you put the exact same steak in tomorrow, it produces the exact same ground beef, so we can 
 * connect financial orders together without knowing who it is. We add a secret spice (the "salt") 
 * so hackers can't use a dictionary to guess what went in.
 *
 * Technical Terms:
 * Provides Deterministic One-Way Hashing via HMAC-SHA256.
 * Salted pseudonyms prevent Rainbow Table and Dictionary attacks while ensuring stable 
 * database lookups. Enables safe, irreversible primary key replacement in the `users` table.
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
