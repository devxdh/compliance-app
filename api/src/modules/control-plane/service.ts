import type { CoeSigner } from "../../crypto/coe";
import { ApiError, fail } from "../../errors";
import { canonicalJsonStringify, computeTokenHash, computeWormHash } from "./hash";
import { ControlPlaneRepository, type ErasureJobRow } from "./repository";
import type { CreateErasureRequestInput, WorkerAckInput, WorkerOutboxEventInput } from "./schemas";

interface ServiceOptions {
  repository: ControlPlaneRepository;
  signer: CoeSigner;
  workerSharedSecret: string;
  workerClientName: string;
  maxOutboxPayloadBytes: number;
  webhookTimeoutMs?: number;
  now?: () => Date;
}

function resolveCertificateMethod(eventType: "SHRED_SUCCESS" | "USER_HARD_DELETED"): "CRYPTO_SHREDDING_DEK_DELETE" | "DIRECT_DELETE_ROOT_ROW" {
  return eventType === "SHRED_SUCCESS" ? "CRYPTO_SHREDDING_DEK_DELETE" : "DIRECT_DELETE_ROOT_ROW";
}

function isTerminalEventType(eventType: string): eventType is "SHRED_SUCCESS" | "USER_HARD_DELETED" {
  return eventType === "SHRED_SUCCESS" || eventType === "USER_HARD_DELETED";
}

interface TerminalCertificateEnvelope {
  payload: {
    request_id: string;
    subject_opaque_id: string;
    event_type: "SHRED_SUCCESS" | "USER_HARD_DELETED";
    method: "CRYPTO_SHREDDING_DEK_DELETE" | "DIRECT_DELETE_ROOT_ROW";
    legal_framework: string;
    shredded_at: string;
    final_worm_hash: string;
  };
  signature: {
    algorithm: string;
    keyId: string;
    signatureBase64: string;
    publicKeySpkiBase64: string;
  };
}

interface VaultLifecycleSchedule {
  notificationDueAt: Date;
  shredDueAt: Date;
}

/**
 * Domain service for zero-PII control-plane orchestration.
 */
export class ControlPlaneService {
  private readonly now: () => Date;
  private readonly repository: ControlPlaneRepository;
  private readonly signer: CoeSigner;
  private readonly workerSharedSecret: string;
  private readonly workerClientName: string;
  private readonly maxOutboxPayloadBytes: number;
  private readonly webhookTimeoutMs: number;

  constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.signer = options.signer;
    this.workerSharedSecret = options.workerSharedSecret;
    this.workerClientName = options.workerClientName;
    this.maxOutboxPayloadBytes = options.maxOutboxPayloadBytes;
    this.webhookTimeoutMs = options.webhookTimeoutMs ?? 10_000;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Builds the canonical audit payload that is persisted in the WORM ledger.
   */
  private buildOutboxPayload(input: WorkerOutboxEventInput) {
    return {
      request_id: input.request_id,
      subject_opaque_id: input.subject_opaque_id,
      event_timestamp: input.event_timestamp,
      payload: input.payload,
    };
  }

  private buildTerminalCertificatePayload(
    job: ErasureJobRow,
    eventType: "SHRED_SUCCESS" | "USER_HARD_DELETED",
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

  /**
   * Extracts the Worker-computed retention schedule from a `USER_VAULTED` payload.
   *
   * The Worker is the sole source of legal evidence evaluation, but the Control Plane owns
   * all future time progression. These timestamps must therefore be persisted durably the
   * moment the vault event is accepted.
   *
   * @param payload - Canonical outbox payload emitted by the Worker.
   * @returns Parsed notification/shred schedule.
   * @throws {ApiError} When the required schedule fields are missing or invalid.
   */
  private parseVaultLifecycleSchedule(payload: Record<string, unknown>): VaultLifecycleSchedule {
    const notificationCandidate =
      typeof payload.notification_due_at === "string"
        ? payload.notification_due_at
        : typeof payload.notificationDueAt === "string"
          ? payload.notificationDueAt
          : null;
    const shredCandidate =
      typeof payload.retention_expiry === "string"
        ? payload.retention_expiry
        : typeof payload.retentionExpiry === "string"
          ? payload.retentionExpiry
          : null;

    if (!notificationCandidate || !shredCandidate) {
      fail({
        code: "API_OUTBOX_VAULT_SCHEDULE_MISSING",
        title: "Vault schedule metadata missing",
        detail: "USER_VAULTED payload must include notification_due_at and retention_expiry.",
        status: 400,
        category: "validation",
        retryable: false,
      });
    }

    const notificationDueAt = new Date(notificationCandidate);
    const shredDueAt = new Date(shredCandidate);
    if (Number.isNaN(notificationDueAt.getTime()) || Number.isNaN(shredDueAt.getTime())) {
      fail({
        code: "API_OUTBOX_VAULT_SCHEDULE_INVALID",
        title: "Vault schedule metadata invalid",
        detail: "USER_VAULTED payload must carry valid ISO-8601 notification_due_at and retention_expiry timestamps.",
        status: 400,
        category: "validation",
        retryable: false,
      });
    }

    if (notificationDueAt.getTime() > shredDueAt.getTime()) {
      fail({
        code: "API_OUTBOX_VAULT_SCHEDULE_CONFLICT",
        title: "Vault schedule order invalid",
        detail: "notification_due_at cannot occur after retention_expiry.",
        status: 409,
        category: "integrity",
        retryable: false,
      });
    }

    return {
      notificationDueAt,
      shredDueAt,
    };
  }

  private async dispatchTerminalWebhook(
    webhookUrl: string,
    webhookIdempotencyKey: string,
    payload: {
      request_id: string;
      subject_opaque_id: string;
      event_type: "SHRED_SUCCESS" | "USER_HARD_DELETED";
      legal_framework: string;
      shredded_at: string;
      certificate: {
        request_id: string;
        subject_opaque_id: string;
        event_type: "SHRED_SUCCESS" | "USER_HARD_DELETED";
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.webhookTimeoutMs);

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": webhookIdempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
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

  private isCreateRequestEquivalent(existing: ErasureJobRow, input: CreateErasureRequestInput): boolean {
    return (
      existing.subject_opaque_id === input.subject_opaque_id &&
      existing.trigger_source === input.trigger_source &&
      existing.actor_opaque_id === input.actor_opaque_id &&
      existing.legal_framework === input.legal_framework &&
      existing.request_timestamp.toISOString() === new Date(input.request_timestamp).toISOString() &&
      existing.tenant_id === (input.tenant_id ?? null) &&
      existing.cooldown_days === input.cooldown_days &&
      existing.shadow_mode === input.shadow_mode &&
      existing.webhook_url === (input.webhook_url ?? null)
    );
  }

  /**
   * Validates whether an outbox retry matches a previously committed event exactly.
   */
  private isReplayEquivalent(
    existing: {
      client_id: string;
      event_type: string;
      payload: unknown;
      previous_hash: string;
      current_hash: string;
    },
    input: WorkerOutboxEventInput,
    clientId: string
  ): boolean {
    if (existing.client_id !== clientId) {
      return false;
    }

    if (existing.event_type !== input.event_type) {
      return false;
    }

    if (existing.previous_hash !== input.previous_hash || existing.current_hash !== input.current_hash) {
      return false;
    }

    return (
      canonicalJsonStringify(existing.payload) === canonicalJsonStringify(this.buildOutboxPayload(input))
    );
  }

  private async ensureTerminalCertificate(
    job: ErasureJobRow,
    eventType: "SHRED_SUCCESS" | "USER_HARD_DELETED",
    shreddedAt: Date,
    finalWormHash: string
  ): Promise<TerminalCertificateEnvelope> {
    const payload = this.buildTerminalCertificatePayload(job, eventType, shreddedAt, finalWormHash);
    const existingCertificate = await this.repository.getCertificateByRequestId(job.id);
    if (existingCertificate) {
      if (canonicalJsonStringify(existingCertificate.payload) !== canonicalJsonStringify(payload)) {
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

    const signature = await this.signer.sign(payload);
    const inserted = await this.repository.insertCertificate({
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
      const racedCertificate = await this.repository.getCertificateByRequestId(job.id);
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

      if (canonicalJsonStringify(racedCertificate.payload) !== canonicalJsonStringify(payload)) {
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

  private async finalizeTerminalOutboxEvent(
    job: ErasureJobRow,
    eventType: "SHRED_SUCCESS" | "USER_HARD_DELETED",
    shreddedAt: Date,
    currentHash: string
  ): Promise<void> {
    const certificate = await this.ensureTerminalCertificate(job, eventType, shreddedAt, currentHash);
    if (!job.webhook_url) {
      return;
    }

    await this.dispatchTerminalWebhook(
      job.webhook_url,
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

  /**
   * Applies deterministic Control Plane state transitions for a committed Worker outbox event.
   *
   * This method is intentionally replay-safe. If the API crashes after appending the WORM ledger
   * but before updating the state machine, a Worker retry must be able to restore the same
   * lifecycle transition without creating duplicate tasks or certificates.
   *
   * @param job - Existing erasure job.
   * @param input - Validated Worker outbox event.
   * @param now - Request clock anchor.
   * @returns Promise resolved once job state and terminal side effects are fully applied.
   */
  private async applyOutboxLifecycle(job: ErasureJobRow, input: WorkerOutboxEventInput, now: Date): Promise<void> {
    const schedule = input.event_type === "USER_VAULTED" ? this.parseVaultLifecycleSchedule(input.payload) : null;
    const shreddedAt = isTerminalEventType(input.event_type) ? new Date(input.event_timestamp) : undefined;

    await this.repository.transitionJobFromOutbox({
      jobId: input.request_id,
      eventType: input.event_type,
      now,
      notificationDueAt: schedule?.notificationDueAt,
      shredDueAt: schedule?.shredDueAt,
      shreddedAt,
    });

    if (isTerminalEventType(input.event_type)) {
      await this.finalizeTerminalOutboxEvent(job, input.event_type, shreddedAt!, input.current_hash);
    }
  }

  /**
   * Registers an erasure request and queues the first worker task.
   *
   * @param input - Validated erasure ingestion payload.
   * @returns Request/task identifiers plus idempotent replay indicator.
   * @throws {ApiError} When idempotency key is reused with a different payload.
   */
  async createErasureRequest(input: CreateErasureRequestInput) {
    const existingJob = await this.repository.getJobByIdempotencyKey(input.idempotency_key);
    if (existingJob) {
      if (!this.isCreateRequestEquivalent(existingJob, input)) {
        fail({
          code: "API_ERASURE_REQUEST_IDEMPOTENCY_CONFLICT",
          title: "Idempotency key conflict",
          detail: `idempotency_key ${input.idempotency_key} already exists with a different request payload.`,
          status: 409,
          category: "integrity",
          retryable: false,
        });
      }

      const existingTask = await this.repository.getTaskByJobId(existingJob.id);
      return {
        request_id: existingJob.id,
        task_id: existingTask?.id ?? null,
        accepted_at: existingJob.created_at.toISOString(),
        idempotent_replay: true as const,
      };
    }

    const now = this.now();
    const jobId = globalThis.crypto.randomUUID();
    const taskId = globalThis.crypto.randomUUID();
    const tokenHash = await computeTokenHash(this.workerSharedSecret);
    const client = await this.repository.ensureClient(this.workerClientName, tokenHash);

    const created = await this.repository.createJobAndQueueTask({
      jobId,
      taskId,
      clientId: client.id,
      request: input,
      payload: {
        request_id: jobId,
        subject_opaque_id: input.subject_opaque_id,
        idempotency_key: input.idempotency_key,
        trigger_source: input.trigger_source,
        actor_opaque_id: input.actor_opaque_id,
        legal_framework: input.legal_framework,
        request_timestamp: input.request_timestamp,
        tenant_id: input.tenant_id,
        cooldown_days: input.cooldown_days,
        shadow_mode: input.shadow_mode,
        webhook_url: input.webhook_url,
      },
      now,
    });

    return {
      request_id: created.job.id,
      task_id: created.task.id,
      accepted_at: created.job.created_at.toISOString(),
      idempotent_replay: false as const,
    };
  }

  /**
   * Authenticates a worker using client name + bearer token hash matching.
   *
   * @param clientName - Worker client name from header.
   * @param bearerToken - Raw bearer token.
   * @returns Worker client id when credentials match, otherwise `null`.
   */
  async authorizeWorker(clientName: string, bearerToken: string): Promise<string | null> {
    const client = await this.repository.getClientByName(clientName);
    if (!client) {
      return null;
    }

    const tokenHash = await computeTokenHash(bearerToken);
    return tokenHash === client.worker_api_key_hash ? client.id : null;
  }

  /**
   * Leases at most one pending task for the authenticated worker.
   *
   * @param clientName - Worker client name for lease attribution.
   * @param clientId - Authenticated worker client id.
   * @returns Pending task envelope or `pending: false`.
   */
  async syncWorker(clientName: string, clientId: string) {
    const task = await this.repository.claimNextTask(clientId, clientName, this.now());

    if (!task) {
      return { pending: false as const };
    }

    return {
      pending: true as const,
      task: {
        id: task.id,
        task_type: task.task_type,
        payload: task.payload,
      },
    };
  }

  /**
   * Cancels a queued erasure request before the cooldown window completes.
   *
   * @param idempotencyKey - Request idempotency UUID.
   * @returns Cancellation payload or `null` when request does not exist.
   * @throws {ApiError} When request is already beyond cancellable states.
   */
  async cancelErasureRequest(idempotencyKey: string) {
    const existingJob = await this.repository.getJobByIdempotencyKey(idempotencyKey);
    if (!existingJob) {
      return null;
    }

    if (existingJob.status === "CANCELLED") {
      return {
        request_id: existingJob.id,
        status: existingJob.status,
        cancelled: true as const,
        idempotent_replay: true as const,
      };
    }

    if (existingJob.status !== "WAITING_COOLDOWN") {
      fail({
        code: "API_ERASURE_REQUEST_CANCEL_INVALID_STATE",
        title: "Erasure request cannot be cancelled",
        detail: `Erasure request ${existingJob.id} is already ${existingJob.status}.`,
        status: 409,
        category: "concurrency",
        retryable: false,
      });
    }

    const cancelled = await this.repository.cancelWaitingJobByIdempotencyKey(idempotencyKey, this.now());
    if (!cancelled) {
      fail({
        code: "API_ERASURE_REQUEST_CANCEL_RACE",
        title: "Cancellation race detected",
        detail: `Erasure request ${existingJob.id} changed state before cancellation completed.`,
        status: 409,
        category: "concurrency",
        retryable: true,
      });
    }

    return {
      request_id: cancelled.id,
      status: cancelled.status,
      cancelled: true as const,
      idempotent_replay: false as const,
    };
  }

  /**
   * Finalizes an active worker task.
   *
   * @param taskId - Task UUID.
   * @param input - Worker ack payload.
   * @returns Updated task status payload or `null` when task is unknown.
   */
  async ackWorkerTask(taskId: string, input: WorkerAckInput) {
    const task = await this.repository.ackTask(taskId, input.status, input.result, this.now());
    if (!task) {
      return null;
    }

    return {
      task_id: task.id,
      status: task.status,
    };
  }

  /**
   * Ingests worker outbox events with chain validation and idempotent replay handling.
   *
   * @param input - Validated outbox event from worker.
   * @param clientId - Authenticated worker client id.
   * @returns Acceptance result with idempotent replay flag.
   * @throws {ApiError} On chain mismatch, payload conflicts, or authorization violations.
   */
  async ingestWorkerOutbox(input: WorkerOutboxEventInput, clientId: string) {
    const now = this.now();
    const job = await this.repository.getJobById(input.request_id);
    if (!job) {
      fail({
        code: "API_OUTBOX_REQUEST_UNKNOWN",
        title: "Unknown request id",
        detail: `Unknown request_id: ${input.request_id}.`,
        status: 404,
        category: "validation",
        retryable: false,
      });
    }

    if (job.client_id !== clientId) {
      fail({
        code: "API_OUTBOX_WORKER_UNAUTHORIZED",
        title: "Worker is not authorized for this request",
        detail: `Worker is not authorized to append events for request ${input.request_id}.`,
        status: 403,
        category: "authorization",
        retryable: false,
      });
    }

    if (job.subject_opaque_id !== input.subject_opaque_id) {
      fail({
        code: "API_OUTBOX_SUBJECT_MISMATCH",
        title: "Subject mismatch",
        detail: `subject_opaque_id does not match request ${input.request_id}.`,
        status: 409,
        category: "integrity",
        retryable: false,
      });
    }

    const existingEvent = await this.repository.getAuditEventByIdempotencyKey(input.idempotency_key);
    if (existingEvent) {
      if (this.isReplayEquivalent(existingEvent, input, clientId)) {
        await this.applyOutboxLifecycle(job, input, now);
        return { accepted: true as const, idempotent_replay: true as const };
      }

      fail({
        code: "API_OUTBOX_IDEMPOTENCY_CONFLICT",
        title: "Outbox idempotency conflict",
        detail: `idempotency_key ${input.idempotency_key} already exists with a different event payload.`,
        status: 409,
        category: "integrity",
        retryable: false,
      });
    }

    const payloadBytes = new TextEncoder().encode(canonicalJsonStringify(input.payload)).byteLength;
    if (payloadBytes > this.maxOutboxPayloadBytes) {
      fail({
        code: "API_OUTBOX_PAYLOAD_TOO_LARGE",
        title: "Outbox payload too large",
        detail: `Outbox payload exceeds ${this.maxOutboxPayloadBytes} bytes.`,
        status: 413,
        category: "validation",
        retryable: false,
      });
    }

    const latestHash = (await this.repository.getLatestAuditHash(clientId)) ?? "GENESIS";
    if (input.previous_hash !== latestHash) {
      fail({
        code: "API_OUTBOX_PREVIOUS_HASH_INVALID",
        title: "Outbox chain head mismatch",
        detail: "previous_hash does not match the latest audit ledger hash.",
        status: 409,
        category: "integrity",
        retryable: false,
      });
    }

    const expectedCurrentHash = await computeWormHash(input.previous_hash, input.payload);
    if (expectedCurrentHash !== input.current_hash) {
      fail({
        code: "API_OUTBOX_CURRENT_HASH_INVALID",
        title: "Outbox chain hash invalid",
        detail: "current_hash is invalid for the provided payload chain.",
        status: 400,
        category: "integrity",
        retryable: false,
      });
    }

    const outboxPayload = this.buildOutboxPayload(input);
    const inserted = await this.repository.insertAuditLedgerEvent({
      clientId,
      idempotencyKey: input.idempotency_key,
      eventType: input.event_type,
      payload: outboxPayload,
      previousHash: input.previous_hash,
      currentHash: input.current_hash,
      now,
    });

    if (!inserted) {
      const racedEvent = await this.repository.getAuditEventByIdempotencyKey(input.idempotency_key);
      if (racedEvent && this.isReplayEquivalent(racedEvent, input, clientId)) {
        await this.applyOutboxLifecycle(job, input, now);
        return { accepted: true as const, idempotent_replay: true as const };
      }

      fail({
        code: "API_OUTBOX_RACE_CONFLICT",
        title: "Outbox idempotency race conflict",
        detail: `idempotency_key ${input.idempotency_key} conflicted with a different event during insert.`,
        status: 409,
        category: "concurrency",
        retryable: true,
      });
    }

    await this.applyOutboxLifecycle(job, input, now);

    return { accepted: true as const, idempotent_replay: false as const };
  }

  /**
   * Fetches a minted Certificate of Erasure by request id.
   *
   * @param requestId - Erasure request UUID.
   * @returns Certificate row or `null`.
   */
  async getCertificate(requestId: string) {
    return this.repository.getCertificateByRequestId(requestId);
  }
}
