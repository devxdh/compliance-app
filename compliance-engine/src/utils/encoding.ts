/**
 * Web-native byte encoding helpers for Bun/Web Crypto code paths.
 */

function bytesToBinary(bytes: Uint8Array): string {
  let output = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return output;
}

/**
 * Encodes raw bytes as base64.
 *
 * @param bytes - Binary payload.
 * @returns Base64 string.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes));
}

/**
 * Decodes base64 text into raw bytes.
 *
 * @param value - Base64 payload.
 * @returns Decoded bytes.
 * @throws {TypeError} When the input is not valid base64.
 */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

/**
 * Encodes raw bytes as lowercase hexadecimal.
 *
 * @param bytes - Binary payload.
 * @returns Lowercase hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Decodes hexadecimal text into raw bytes.
 *
 * @param value - Hex payload.
 * @returns Decoded bytes.
 * @throws {TypeError} When the input is not valid even-length hex.
 */
export function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || /[^0-9a-f]/i.test(value)) {
    throw new TypeError("Invalid hexadecimal string.");
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }

  return bytes;
}
