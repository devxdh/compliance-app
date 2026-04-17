const textEncoder = new TextEncoder();

export function hexEncode(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const data = textEncoder.encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return hexEncode(digest);
}
