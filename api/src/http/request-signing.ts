import type { Context, Next } from "hono";
import { fail } from "../errors";

const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );
}

/**
 * Computes the canonical worker/API request signature.
 *
 * @param secret - Shared HMAC secret.
 * @param method - HTTP method.
 * @param path - Request path.
 * @param clientId - Worker client identifier.
 * @param timestamp - Unix epoch milliseconds string.
 * @param bodyText - Exact request body text.
 * @returns Lowercase hex HMAC digest.
 */
export async function computeRequestSignature(
  secret: string,
  method: string,
  path: string,
  clientId: string,
  timestamp: string,
  bodyText: string
): Promise<string> {
  const key = await importSigningKey(secret);
  const payload = textEncoder.encode(
    [method.toUpperCase(), path, clientId, timestamp, bodyText].join("\n")
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, payload);
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Creates middleware verifying HMAC-signed worker requests within a bounded clock-skew window.
 *
 * @param secret - Shared HMAC secret. When absent, request signing is disabled.
 * @param maxSkewMs - Allowed timestamp skew in milliseconds.
 * @returns Hono middleware for worker routes.
 */
export function createWorkerRequestSigningMiddleware(
  secret: string | undefined,
  maxSkewMs: number
) {
  return async (c: Context, next: Next): Promise<void> => {
    if (!secret) {
      await next();
      return;
    }

    const clientId = c.req.header("x-client-id") ?? "";
    const timestamp = c.req.header("x-dpdp-timestamp");
    const signature = c.req.header("x-dpdp-signature");
    if (!timestamp || !signature || !clientId) {
      fail({
        code: "API_WORKER_SIGNATURE_MISSING",
        title: "Missing worker request signature",
        detail: "Worker request signing headers are required.",
        status: 401,
        category: "authentication",
        retryable: false,
      });
    }

    const timestampMs = Number(timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > maxSkewMs) {
      fail({
        code: "API_WORKER_SIGNATURE_EXPIRED",
        title: "Expired worker request signature",
        detail: "Worker request signature timestamp is outside the allowed clock-skew window.",
        status: 401,
        category: "authentication",
        retryable: false,
      });
    }

    const bodyText = c.req.method === "GET" ? "" : await c.req.raw.clone().text();
    const expected = await computeRequestSignature(
      secret,
      c.req.method,
      c.req.path,
      clientId,
      timestamp,
      bodyText
    );

    if (expected !== signature.toLowerCase()) {
      fail({
        code: "API_WORKER_SIGNATURE_INVALID",
        title: "Invalid worker request signature",
        detail: "Worker request signature verification failed.",
        status: 401,
        category: "authentication",
        retryable: false,
      });
    }

    await next();
  };
}
