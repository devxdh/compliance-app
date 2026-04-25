import { bytesToHex } from "../utils/encoding";

const textEncoder = new TextEncoder();

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export interface AwsSignedRequestInput {
  method: string;
  url: URL;
  region: string;
  service: string;
  headers: Headers;
  body?: Uint8Array | string;
  credentials: AwsCredentials;
  now?: Date;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

function encodeBody(body: Uint8Array | string | undefined): Uint8Array {
  if (body === undefined) {
    return new Uint8Array(0);
  }

  return typeof body === "string" ? copyBytes(textEncoder.encode(body)) : copyBytes(body);
}

async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === "string" ? textEncoder.encode(input) : input;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256(key: Uint8Array, value: string): Promise<Uint8Array> {
  const keyBytes = key.slice();
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const data = textEncoder.encode(value).slice();
  const signature = await globalThis.crypto.subtle.sign("HMAC", cryptoKey, data.buffer as ArrayBuffer);
  return new Uint8Array(signature);
}

function buildCanonicalQuery(searchParams: URLSearchParams): string {
  return Array.from(searchParams.entries())
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      const byName = leftName.localeCompare(rightName);
      return byName === 0 ? leftValue.localeCompare(rightValue) : byName;
    })
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
}

function normalizeAmzDate(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Signs an AWS REST request with Signature Version 4 using Web Crypto HMAC-SHA256.
 *
 * @param input - Request method, URL, headers, body, service, region, and credentials.
 * @returns Headers containing SigV4 authorization fields.
 */
export async function signAwsRequest(input: AwsSignedRequestInput): Promise<Headers> {
  const bodyBytes = encodeBody(input.body);
  const payloadHash = await sha256Hex(bodyBytes);
  const { amzDate, dateStamp } = normalizeAmzDate(input.now ?? new Date());
  const headers = new Headers(input.headers);

  headers.set("host", input.url.host);
  headers.set("x-amz-content-sha256", payloadHash);
  headers.set("x-amz-date", amzDate);
  if (input.credentials.sessionToken) {
    headers.set("x-amz-security-token", input.credentials.sessionToken);
  }

  const sortedHeaders = Array.from(headers.entries())
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const canonicalHeaders = sortedHeaders.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = sortedHeaders.map(([name]) => name).join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.url.pathname || "/",
    buildCanonicalQuery(input.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const secretSeed = textEncoder.encode(`AWS4${input.credentials.secretAccessKey}`);
  let dateKey: Uint8Array = new Uint8Array(0);
  let regionKey: Uint8Array = new Uint8Array(0);
  let serviceKey: Uint8Array = new Uint8Array(0);
  let signingKey: Uint8Array = new Uint8Array(0);
  let signatureBytes: Uint8Array = new Uint8Array(0);

  try {
    dateKey = await hmacSha256(secretSeed, dateStamp);
    regionKey = await hmacSha256(dateKey, input.region);
    serviceKey = await hmacSha256(regionKey, input.service);
    signingKey = await hmacSha256(serviceKey, "aws4_request");
    signatureBytes = await hmacSha256(signingKey, stringToSign);
    headers.set(
      "authorization",
      `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${bytesToHex(signatureBytes)}`
    );
    return headers;
  } finally {
    secretSeed.fill(0);
    dateKey.fill(0);
    regionKey.fill(0);
    serviceKey.fill(0);
    signingKey.fill(0);
    signatureBytes.fill(0);
  }
}
