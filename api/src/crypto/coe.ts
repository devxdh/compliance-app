import { fail } from "../errors";

const textEncoder = new TextEncoder();

export interface CoeSignature {
  algorithm: "Ed25519";
  keyId: string;
  signatureBase64: string;
  publicKeySpkiBase64: string;
}

export interface CoeSigner {
  sign(payload: unknown): Promise<CoeSignature>;
}

function encodePayload(payload: unknown): ArrayBuffer {
  const source = textEncoder.encode(JSON.stringify(payload));
  const copied = new Uint8Array(source.length);
  copied.set(source);
  return copied.buffer as ArrayBuffer;
}

function toBase64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return Buffer.from(bytes).toString("base64");
}

/**
 * Creates an Ed25519 certificate signer using Web Crypto APIs.
 */
export async function createEd25519Signer(
  keyId: string,
  options: { privateKeyPkcs8Base64?: string; publicKeySpkiBase64?: string } = {}
): Promise<CoeSigner> {
  let privateKey: CryptoKey;
  let publicKeySpkiBase64: string;

  if (options.privateKeyPkcs8Base64) {
    if (!options.publicKeySpkiBase64) {
      fail({
        code: "API_COE_PUBLIC_KEY_MISSING",
        title: "Public key is required",
        detail: "publicKeySpkiBase64 is required when privateKeyPkcs8Base64 is provided.",
        status: 500,
        category: "configuration",
        retryable: false,
        fatal: true,
      });
    }

    privateKey = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      Buffer.from(options.privateKeyPkcs8Base64, "base64"),
      { name: "Ed25519" },
      false,
      ["sign"]
    );
    publicKeySpkiBase64 = options.publicKeySpkiBase64;
  } else {
    const pair = (await globalThis.crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"]
    )) as unknown as CryptoKeyPair;
    privateKey = pair.privateKey;
    const spki = await globalThis.crypto.subtle.exportKey("spki", pair.publicKey);
    publicKeySpkiBase64 = toBase64(spki);
  }

  return {
    async sign(payload: unknown): Promise<CoeSignature> {
      const signature = await globalThis.crypto.subtle.sign("Ed25519", privateKey, encodePayload(payload));

      return {
        algorithm: "Ed25519",
        keyId,
        signatureBase64: toBase64(signature),
        publicKeySpkiBase64,
      };
    },
  };
}

/**
 * Verifies an Ed25519 signature for a JSON payload.
 */
export async function verifyEd25519Signature(
  publicKeySpkiBase64: string,
  signatureBase64: string,
  payload: unknown
): Promise<boolean> {
  const publicKey = await globalThis.crypto.subtle.importKey(
    "spki",
    Buffer.from(publicKeySpkiBase64, "base64"),
    { name: "Ed25519" },
    false,
    ["verify"]
  );

  return globalThis.crypto.subtle.verify(
    "Ed25519",
    publicKey,
    Buffer.from(signatureBase64, "base64"),
    encodePayload(payload)
  );
}
