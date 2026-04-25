import { readFileSync } from "node:fs";
import { z } from "zod";
import { fail } from "../errors";
import { base64ToBytes, bytesToHex, hexToBytes } from "../utils/encoding";
import { readRuntimeSecret } from "./secrets";

const KEY_LENGTH = 32;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy as Uint8Array;
}

const awsKmsSourceSchema = z
  .object({
    provider: z.literal("aws_kms"),
    region: z.string().min(1),
    ciphertext_blob_base64: z.string().min(1),
    key_id: z.string().min(1).optional(),
    encryption_context: z.record(z.string(), z.string()).optional(),
    endpoint: z.url().optional(),
    access_key_id_env: z.string().min(1).default("AWS_ACCESS_KEY_ID"),
    secret_access_key_env: z.string().min(1).default("AWS_SECRET_ACCESS_KEY"),
    session_token_env: z.string().min(1).default("AWS_SESSION_TOKEN"),
  })
  .strict();

const gcpSecretManagerSourceSchema = z
  .object({
    provider: z.literal("gcp_secret_manager"),
    secret_version: z.string().min(1),
    endpoint: z.url().optional(),
    access_token_env: z.string().min(1).default("GCP_ACCESS_TOKEN"),
    metadata_token_url: z
      .url()
      .default("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"),
  })
  .strict();

const vaultKvV2SourceSchema = z
  .object({
    provider: z.literal("hashicorp_vault"),
    address: z.url().optional(),
    address_env: z.string().min(1).default("VAULT_ADDR"),
    token_env: z.string().min(1).default("VAULT_TOKEN"),
    namespace_env: z.string().min(1).default("VAULT_NAMESPACE"),
    mount: z.string().min(1),
    path: z.string().min(1),
    field: z.string().min(1),
    version: z.number().int().positive().optional(),
  })
  .strict();

const fileSourceSchema = z
  .object({
    provider: z.literal("file"),
    path: z.string().min(1),
  })
  .strict();

const envSourceSchema = z
  .object({
    provider: z.literal("env"),
    env: z.string().min(1),
  })
  .strict();

/**
 * Strict key-source contract for runtime KEK/HMAC retrieval.
 *
 * The worker accepts direct env/file sources for local operation and native HTTP adapters for
 * AWS KMS, Google Secret Manager, and Vault KV v2. Remote providers are resolved only by the
 * asynchronous boot path so tests and local development remain deterministic.
 */
export const keySourceSchema = z.discriminatedUnion("provider", [
  envSourceSchema,
  fileSourceSchema,
  awsKmsSourceSchema,
  gcpSecretManagerSourceSchema,
  vaultKvV2SourceSchema,
]);

export type KeySourceConfig = z.infer<typeof keySourceSchema>;

interface ResolveKeyOptions {
  env: Record<string, string | undefined>;
  keyName: string;
  legacyEnvName: string;
  fallbackLegacyEnvName?: string;
  source?: KeySourceConfig;
  fetchFn?: typeof fetch;
}

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function normalizeBase64(value: string): string {
  return value.trim().replace(/-/g, "+").replace(/_/g, "/");
}

function requiredRuntimeSecret(env: Record<string, string | undefined>, envName: string, purpose: string): string {
  const value = readRuntimeSecret(env, envName);
  if (!value) {
    fail({
      code: "DPDP_KMS_SECRET_MISSING",
      title: "Runtime secret is missing",
      detail: `${envName} is required to resolve ${purpose}.`,
      category: "configuration",
      retryable: false,
      fatal: true,
      context: { envName, purpose },
    });
  }

  return value;
}

function ensureKeyLength(bytes: Uint8Array, keyName: string): Uint8Array {
  if (bytes.length === KEY_LENGTH) {
    return new Uint8Array(bytes);
  }

  fail({
    code: "DPDP_SECRET_ENV_INVALID",
    title: "Invalid secret format",
    detail: `${keyName} must resolve to exactly ${KEY_LENGTH} bytes.`,
    category: "configuration",
    retryable: false,
    fatal: true,
    context: { keyName },
  });
}

/**
 * Decodes configured key material from raw bytes or textual hex/base64.
 *
 * @param rawValue - Runtime key value returned by env, file, KMS, Secret Manager, or Vault.
 * @param keyName - Human-readable key label used in fail-closed error details.
 * @returns A defensive copy of the 32-byte key.
 * @throws {WorkerError} If the value cannot be decoded into a 256-bit key.
 */
export function decodeKeyMaterial(rawValue: string | Uint8Array, keyName: string): Uint8Array {
  if (rawValue instanceof Uint8Array) {
    if (rawValue.length === KEY_LENGTH) {
      return new Uint8Array(rawValue);
    }

    rawValue = textDecoder.decode(rawValue);
  }

  const value = rawValue.trim();
  if (value.length === 0) {
    fail({
      code: "DPDP_SECRET_ENV_MISSING",
      title: "Required secret is missing",
      detail: `${keyName} is required.`,
      category: "configuration",
      retryable: false,
      fatal: true,
      context: { keyName },
    });
  }

  const normalizedHex = value.startsWith("hex:") ? value.slice(4) : value;
  if (/^[0-9a-fA-F]+$/.test(normalizedHex) && normalizedHex.length === KEY_LENGTH * 2) {
    return hexToBytes(normalizedHex);
  }

  const normalizedBase64 = value.startsWith("base64:") ? value.slice(7) : value;
  try {
    return ensureKeyLength(base64ToBytes(normalizeBase64(normalizedBase64)), keyName);
  } catch {
    fail({
      code: "DPDP_SECRET_ENV_INVALID",
      title: "Invalid secret format",
      detail: `${keyName} must decode to exactly ${KEY_LENGTH} bytes. Supported formats: 64-char hex or base64.`,
      category: "configuration",
      retryable: false,
      fatal: true,
      context: { keyName },
    });
  }
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copyBytes(textEncoder.encode(value))))
  );
}

async function hmacSha256(key: Uint8Array, value: string | Uint8Array): Promise<Uint8Array> {
  const keyBytes = copyBytes(key);
  const data = typeof value === "string" ? copyBytes(textEncoder.encode(value)) : copyBytes(value);
  try {
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", cryptoKey, data));
  } finally {
    keyBytes.fill(0);
    data.fill(0);
  }
}

async function signAwsKmsRequest(
  endpoint: URL,
  region: string,
  body: string,
  credentials: AwsCredentials,
  now: Date = new Date()
): Promise<Headers> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body);
  const headers = new Headers({
    "content-type": "application/x-amz-json-1.1",
    host: endpoint.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "x-amz-target": "TrentService.Decrypt",
  });

  if (credentials.sessionToken) {
    headers.set("x-amz-security-token", credentials.sessionToken);
  }

  const sortedHeaders = Array.from(headers.entries()).sort(([left], [right]) => left.localeCompare(right));
  const canonicalHeaders = sortedHeaders
    .map(([name, value]) => `${name.toLowerCase()}:${value.trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = sortedHeaders.map(([name]) => name.toLowerCase()).join(";");
  const canonicalRequest = [
    "POST",
    endpoint.pathname || "/",
    endpoint.search.length > 1 ? endpoint.search.slice(1) : "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/kms/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const secretSeed = copyBytes(textEncoder.encode(`AWS4${credentials.secretAccessKey}`));
  let dateKey: Uint8Array = new Uint8Array(0);
  let regionKey: Uint8Array = new Uint8Array(0);
  let serviceKey: Uint8Array = new Uint8Array(0);
  let signingKey: Uint8Array = new Uint8Array(0);
  let signatureBytes: Uint8Array = new Uint8Array(0);

  try {
    dateKey = await hmacSha256(secretSeed, dateStamp);
    regionKey = await hmacSha256(dateKey, region);
    serviceKey = await hmacSha256(regionKey, "kms");
    signingKey = await hmacSha256(serviceKey, "aws4_request");
    signatureBytes = await hmacSha256(signingKey, stringToSign);
    const signature = bytesToHex(signatureBytes);

    headers.set(
      "authorization",
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    );
  } finally {
    secretSeed.fill(0);
    dateKey.fill(0);
    regionKey.fill(0);
    serviceKey.fill(0);
    signingKey.fill(0);
    signatureBytes.fill(0);
  }

  return headers;
}

async function fetchJson(fetchFn: typeof fetch, url: string | URL, init: RequestInit, provider: string): Promise<unknown> {
  const response = await fetchFn(url, {
    ...init,
    redirect: "error",
  });
  if (!response.ok) {
    fail({
      code: "DPDP_KMS_PROVIDER_FAILED",
      title: "Key provider request failed",
      detail: `${provider} responded with HTTP ${response.status}.`,
      category: "external",
      retryable: response.status >= 500 || response.status === 429,
      fatal: response.status >= 400 && response.status < 500 && response.status !== 429,
      context: { provider, status: response.status },
    });
  }

  return response.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function resolveAwsKmsKey(source: Extract<KeySourceConfig, { provider: "aws_kms" }>, options: ResolveKeyOptions): Promise<Uint8Array> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const endpoint = new URL(source.endpoint ?? `https://kms.${source.region}.amazonaws.com/`);
  const body = JSON.stringify({
    CiphertextBlob: source.ciphertext_blob_base64,
    ...(source.key_id ? { KeyId: source.key_id } : {}),
    ...(source.encryption_context ? { EncryptionContext: source.encryption_context } : {}),
  });
  const headers = await signAwsKmsRequest(endpoint, source.region, body, {
    accessKeyId: requiredRuntimeSecret(options.env, source.access_key_id_env, options.keyName),
    secretAccessKey: requiredRuntimeSecret(options.env, source.secret_access_key_env, options.keyName),
    sessionToken: readRuntimeSecret(options.env, source.session_token_env) || undefined,
  });

  const json = await fetchJson(fetchFn, endpoint, { method: "POST", headers, body }, "AWS KMS");
  if (!isRecord(json) || typeof json.Plaintext !== "string") {
    fail({
      code: "DPDP_KMS_RESPONSE_INVALID",
      title: "Key provider response invalid",
      detail: "AWS KMS response did not include a base64 Plaintext field.",
      category: "external",
      retryable: false,
      fatal: true,
      context: { provider: "aws_kms" },
    });
  }

  return decodeKeyMaterial(base64ToBytes(normalizeBase64(json.Plaintext)), options.keyName);
}

async function resolveGcpToken(source: Extract<KeySourceConfig, { provider: "gcp_secret_manager" }>, options: ResolveKeyOptions): Promise<string> {
  const envToken = readRuntimeSecret(options.env, source.access_token_env);
  if (envToken) {
    return envToken;
  }

  const json = await fetchJson(
    options.fetchFn ?? globalThis.fetch,
    source.metadata_token_url,
    {
      method: "GET",
      headers: {
        "metadata-flavor": "Google",
      },
    },
    "GCP metadata server"
  );
  if (!isRecord(json) || typeof json.access_token !== "string") {
    fail({
      code: "DPDP_KMS_RESPONSE_INVALID",
      title: "Key provider response invalid",
      detail: "GCP metadata token response did not include access_token.",
      category: "external",
      retryable: true,
      fatal: false,
      context: { provider: "gcp_metadata" },
    });
  }

  return json.access_token;
}

async function resolveGcpSecretManagerKey(
  source: Extract<KeySourceConfig, { provider: "gcp_secret_manager" }>,
  options: ResolveKeyOptions
): Promise<Uint8Array> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const endpoint = source.endpoint ?? `https://secretmanager.googleapis.com/v1/${source.secret_version}:access`;
  const accessToken = await resolveGcpToken(source, options);
  const json = await fetchJson(
    fetchFn,
    endpoint,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    },
    "GCP Secret Manager"
  );

  const payload = isRecord(json) && isRecord(json.payload) ? json.payload : null;
  if (!payload || typeof payload.data !== "string") {
    fail({
      code: "DPDP_KMS_RESPONSE_INVALID",
      title: "Key provider response invalid",
      detail: "GCP Secret Manager response did not include payload.data.",
      category: "external",
      retryable: false,
      fatal: true,
      context: { provider: "gcp_secret_manager" },
    });
  }

  return decodeKeyMaterial(base64ToBytes(normalizeBase64(payload.data)), options.keyName);
}

function encodeVaultPathSegment(value: string): string {
  return value
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function resolveVaultKey(source: Extract<KeySourceConfig, { provider: "hashicorp_vault" }>, options: ResolveKeyOptions): Promise<Uint8Array> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const address = source.address ?? readRuntimeSecret(options.env, source.address_env);
  if (!address) {
    fail({
      code: "DPDP_KMS_SECRET_MISSING",
      title: "Runtime secret is missing",
      detail: `${source.address_env} or security key source address is required to resolve ${options.keyName}.`,
      category: "configuration",
      retryable: false,
      fatal: true,
      context: { provider: "hashicorp_vault", addressEnv: source.address_env },
    });
  }

  const url = new URL(
    `/v1/${encodeVaultPathSegment(source.mount)}/data/${encodeVaultPathSegment(source.path)}`,
    address.endsWith("/") ? address : `${address}/`
  );
  if (source.version !== undefined) {
    url.searchParams.set("version", String(source.version));
  }

  const headers = new Headers({
    "x-vault-token": requiredRuntimeSecret(options.env, source.token_env, options.keyName),
  });
  const namespace = readRuntimeSecret(options.env, source.namespace_env);
  if (namespace) {
    headers.set("x-vault-namespace", namespace);
  }

  const json = await fetchJson(fetchFn, url, { method: "GET", headers }, "HashiCorp Vault");
  const data = isRecord(json) && isRecord(json.data) && isRecord(json.data.data) ? json.data.data : null;
  const rawValue = data?.[source.field];
  if (typeof rawValue !== "string") {
    fail({
      code: "DPDP_KMS_RESPONSE_INVALID",
      title: "Key provider response invalid",
      detail: `HashiCorp Vault response did not include data.data.${source.field}.`,
      category: "external",
      retryable: false,
      fatal: true,
      context: { provider: "hashicorp_vault", field: source.field },
    });
  }

  return decodeKeyMaterial(rawValue, options.keyName);
}

function readLegacyEnvKey(options: ResolveKeyOptions): Uint8Array {
  const value =
    readRuntimeSecret(options.env, options.legacyEnvName) ||
    (options.fallbackLegacyEnvName ? readRuntimeSecret(options.env, options.fallbackLegacyEnvName) : "");
  return decodeKeyMaterial(value, options.keyName);
}

/**
 * Resolves a configured key source using only synchronous local sources.
 *
 * @param options - Key lookup contract and runtime environment map.
 * @returns A 32-byte key resolved from env or file.
 * @throws {WorkerError} If a remote key provider is configured on the sync path.
 */
export function resolveConfiguredKeySync(options: ResolveKeyOptions): Uint8Array {
  const source = options.source;
  if (!source) {
    return readLegacyEnvKey(options);
  }

  if (source.provider === "env") {
    return decodeKeyMaterial(requiredRuntimeSecret(options.env, source.env, options.keyName), options.keyName);
  }

  if (source.provider === "file") {
    return decodeKeyMaterial(readFileSync(source.path, "utf8"), options.keyName);
  }

  fail({
    code: "DPDP_KMS_ASYNC_PROVIDER_ON_SYNC_PATH",
    title: "Remote key provider requires async boot",
    detail: `${source.provider} key sources require readWorkerConfigFromRuntime().`,
    category: "configuration",
    retryable: false,
    fatal: true,
    context: { provider: source.provider, keyName: options.keyName },
  });
}

/**
 * Resolves a configured key source from env, file, AWS KMS, GCP Secret Manager, or Vault KV v2.
 *
 * @param options - Key lookup contract and runtime environment map.
 * @returns A 32-byte key suitable for Web Crypto operations.
 * @throws {WorkerError} If retrieval fails or the provider returns invalid key material.
 */
export async function resolveConfiguredKey(options: ResolveKeyOptions): Promise<Uint8Array> {
  const source = options.source;
  if (!source) {
    return readLegacyEnvKey(options);
  }

  if (source.provider === "env" || source.provider === "file") {
    return resolveConfiguredKeySync(options);
  }

  if (source.provider === "aws_kms") {
    return resolveAwsKmsKey(source, options);
  }

  if (source.provider === "gcp_secret_manager") {
    return resolveGcpSecretManagerKey(source, options);
  }

  return resolveVaultKey(source, options);
}
