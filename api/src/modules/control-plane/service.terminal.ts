import type { CoeSigner } from "../../crypto/coe";
import { ApiError, fail } from "../../errors";
import { canonicalJsonStringify } from "./hash";
import type { ControlPlaneRepository, ErasureJobRow } from "./repository";
import type {
  TerminalCertificateEnvelope,
  TerminalCertificateMethod,
  TerminalEventType,
} from "./service.types";
import { assertSafeWebhookDispatchTarget } from "./webhook";

/**
 * Returns the Certificate of Erasure method code bound into the signed payload.
 *
 * @param eventType - Terminal worker event that completed the subject lifecycle.
 * @returns Stable method code persisted in the signed certificate.
 */
export function resolveCertificateMethod(
  eventType: TerminalEventType
): TerminalCertificateMethod {
  return eventType === "SHRED_SUCCESS"
    ? "CRYPTO_SHREDDING_DEK_DELETE"
    : "DIRECT_DELETE_ROOT_ROW";
}

/**
 * Narrows arbitrary outbox event strings to the terminal lifecycle events.
 *
 * @param eventType - Worker event type.
 * @returns `true` when the event completes the lifecycle and requires certificate logic.
 */
export function isTerminalEventType(eventType: string): eventType is TerminalEventType {
  return eventType === "SHRED_SUCCESS" || eventType === "USER_HARD_DELETED";
}

function buildTerminalCertificatePayload(
  job: ErasureJobRow,
  eventType: TerminalEventType,
  shreddedAt: Date,
  finalWormHash: string
): TerminalCertificateEnvelope["payload"] {
  return {
    request_id: job.id,
    subject_opaque_id: job.subject_opaque_id,
    event_type: eventType,
    method: resolveCertificateMethod(eventType),
    legal_framework: job.legal_framework,
    shredded_at: shreddedAt.toISOString(),
    final_worm_hash: finalWormHash,
  };
}

async function dispatchTerminalWebhook(
  webhookUrl: string,
  webhookTimeoutMs: number,
  webhookIdempotencyKey: string,
  payload: {
    request_id: string;
    subject_opaque_id: string;
    event_type: TerminalEventType;
    legal_framework: string;
    shredded_at: string;
    certificate: {
      request_id: string;
      subject_opaque_id: string;
      event_type: TerminalEventType;
      method: string;
      legal_framework: string;
      shredded_at: string;
      final_worm_hash: string;
      signature: {
        algorithm: string;
        key_id: string;
        signature_base64: string;
        public_key_spki_base64: string;
      };
    };
  }
): Promise<void> {
  const safeWebhookUrl = await assertSafeWebhookDispatchTarget(webhookUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), webhookTimeoutMs);

  try {
    const response = await fetch(safeWebhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": webhookIdempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "error",
    });

    if (!response.ok) {
      fail({
        code: "API_WEBHOOK_DELIVERY_FAILED",
        title: "Terminal webhook delivery failed",
        detail: `Webhook ${webhookUrl} responded with HTTP ${response.status}.`,
        status: 502,
        category: "external",
        retryable: true,
      });
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    fail({
      code: "API_WEBHOOK_DELIVERY_FAILED",
      title: "Terminal webhook delivery failed",
      detail: `Failed to deliver terminal webhook to ${webhookUrl}.`,
      status: 502,
      category: "external",
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ensures a terminal Certificate of Erasure exists and matches the terminal WORM event exactly.
 *
 * @param repository - Control-plane persistence gateway.
 * @param signer - Ed25519 signer used to mint new certificates.
 * @param job - Existing erasure job.
 * @param eventType - Terminal worker event being finalized.
 * @param shreddedAt - Terminal timestamp bound into the certificate.
 * @param finalWormHash - Final ledger hash committed for the request.
 * @returns Existing or newly created signed certificate envelope.
 * @throws {ApiError} When stored certificate contents conflict with the terminal event.
 */
export async function ensureTerminalCertificate(
  repository: ControlPlaneRepository,
  signer: CoeSigner,
  job: ErasureJobRow,
  eventType: TerminalEventType,
  shreddedAt: Date,
  finalWormHash: string
): Promise<TerminalCertificateEnvelope> {
  const payload = buildTerminalCertificatePayload(
    job,
    eventType,
    shreddedAt,
    finalWormHash
  );
  const existingCertificate = await repository.getCertificateByRequestId(job.id);
  if (existingCertificate) {
    if (
      canonicalJsonStringify(existingCertificate.payload) !==
      canonicalJsonStringify(payload)
    ) {
      fail({
        code: "API_CERTIFICATE_INTEGRITY_CONFLICT",
        title: "Stored certificate payload mismatch",
        detail: `Certificate ${job.id} does not match the terminal WORM event being processed.`,
        status: 409,
        category: "integrity",
        retryable: false,
      });
    }

    return {
      payload,
      signature: {
        algorithm: existingCertificate.algorithm,
        keyId: existingCertificate.key_id,
        signatureBase64: existingCertificate.signature_base64,
        publicKeySpkiBase64: existingCertificate.public_key_spki_base64,
      },
    };
  }

  const signature = await signer.sign(payload);
  const inserted = await repository.insertCertificate({
    requestId: job.id,
    subjectOpaqueId: job.subject_opaque_id,
    method: payload.method,
    legalFramework: job.legal_framework,
    shreddedAt,
    payload,
    signatureBase64: signature.signatureBase64,
    publicKeySpkiBase64: signature.publicKeySpkiBase64,
    keyId: signature.keyId,
    algorithm: signature.algorithm,
  });

  if (!inserted) {
    const racedCertificate = await repository.getCertificateByRequestId(job.id);
    if (!racedCertificate) {
      fail({
        code: "API_CERTIFICATE_INSERT_RACE",
        title: "Certificate insert race failed",
        detail: `Certificate ${job.id} conflicted during insert but no stored certificate could be reloaded.`,
        status: 409,
        category: "concurrency",
        retryable: true,
      });
    }

    if (
      canonicalJsonStringify(racedCertificate.payload) !==
      canonicalJsonStringify(payload)
    ) {
      fail({
        code: "API_CERTIFICATE_INTEGRITY_CONFLICT",
        title: "Stored certificate payload mismatch",
        detail: `Certificate ${job.id} does not match the terminal WORM event being processed.`,
        status: 409,
        category: "integrity",
        retryable: false,
      });
    }

    return {
      payload,
      signature: {
        algorithm: racedCertificate.algorithm,
        keyId: racedCertificate.key_id,
        signatureBase64: racedCertificate.signature_base64,
        publicKeySpkiBase64: racedCertificate.public_key_spki_base64,
      },
    };
  }

  return {
    payload,
    signature: {
      algorithm: signature.algorithm,
      keyId: signature.keyId,
      signatureBase64: signature.signatureBase64,
      publicKeySpkiBase64: signature.publicKeySpkiBase64,
    },
  };
}

/**
 * Completes terminal side effects for a committed terminal outbox event.
 *
 * The WORM append and job transition happen first. This helper then ensures the signed
 * certificate exists and retries webhook delivery idempotently until the worker receives
 * a successful response from the Control Plane.
 *
 * @param repository - Control-plane persistence gateway.
 * @param signer - Ed25519 signer used for certificate issuance.
 * @param webhookTimeoutMs - Hard timeout for outbound webhook calls.
 * @param job - Existing erasure job.
 * @param eventType - Terminal worker event type.
 * @param shreddedAt - Timestamp carried by the worker event.
 * @param currentHash - Final WORM hash for the request lifecycle.
 */
export async function finalizeTerminalOutboxEvent(
  repository: ControlPlaneRepository,
  signer: CoeSigner,
  webhookTimeoutMs: number,
  job: ErasureJobRow,
  eventType: TerminalEventType,
  shreddedAt: Date,
  currentHash: string
): Promise<void> {
  const certificate = await ensureTerminalCertificate(
    repository,
    signer,
    job,
    eventType,
    shreddedAt,
    currentHash
  );
  if (!job.webhook_url) {
    return;
  }

  await dispatchTerminalWebhook(
    job.webhook_url,
    webhookTimeoutMs,
    `webhook:${job.id}:${certificate.payload.final_worm_hash}`,
    {
      request_id: job.id,
      subject_opaque_id: job.subject_opaque_id,
      event_type: eventType,
      legal_framework: job.legal_framework,
      shredded_at: shreddedAt.toISOString(),
      certificate: {
        request_id: job.id,
        subject_opaque_id: job.subject_opaque_id,
        event_type: eventType,
        method: certificate.payload.method,
        legal_framework: job.legal_framework,
        shredded_at: shreddedAt.toISOString(),
        final_worm_hash: certificate.payload.final_worm_hash,
        signature: {
          algorithm: certificate.signature.algorithm,
          key_id: certificate.signature.keyId,
          signature_base64: certificate.signature.signatureBase64,
          public_key_spki_base64: certificate.signature.publicKeySpkiBase64,
        },
      },
    }
  );
}
