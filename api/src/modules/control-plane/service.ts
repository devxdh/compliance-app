import type { CoeSigner } from "../../crypto/coe";
import { fail } from "../../errors";
import { computeTokenHash, computeWormHash } from "./hash";
import { ControlPlaneRepository, type ErasureJobRow } from "./repository";
import type { CreateErasureRequestInput, WorkerAckInput, WorkerOutboxEventInput } from "./schemas";

interface ServiceOptions {
  repository: ControlPlaneRepository;
  signer: CoeSigner;
  workerSharedSecret: string;
  workerClientName: string;
  maxOutboxPayloadBytes: number;
  now?: () => Date;
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

  constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.signer = options.signer;
    this.workerSharedSecret = options.workerSharedSecret;
    this.workerClientName = options.workerClientName;
    this.maxOutboxPayloadBytes = options.maxOutboxPayloadBytes;
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

  /**
   * Normalizes JSON values so semantic equality is stable even when JSONB reorders keys.
   */
  private canonicalizeJson(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.canonicalizeJson(item));
    }

    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, this.canonicalizeJson(nestedValue)]);
      return Object.fromEntries(entries);
    }

    return value;
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
      JSON.stringify(this.canonicalizeJson(existing.payload)) ===
      JSON.stringify(this.canonicalizeJson(this.buildOutboxPayload(input)))
    );
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
    const existingEvent = await this.repository.getAuditEventByIdempotencyKey(input.idempotency_key);
    if (existingEvent) {
      if (this.isReplayEquivalent(existingEvent, input, clientId)) {
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

    const payloadBytes = new TextEncoder().encode(JSON.stringify(input.payload)).byteLength;
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

    const expectedCurrentHash = await computeWormHash(input.previous_hash, input.payload, input.idempotency_key);
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

    if (input.event_type === "SHRED_SUCCESS" || input.event_type === "USER_HARD_DELETED") {
      const shreddedAt = new Date(input.event_timestamp);
      const certificatePayload = {
        request_id: job.id,
        subject_opaque_id: job.subject_opaque_id,
        method:
          input.event_type === "SHRED_SUCCESS" ? "CRYPTO_SHREDDING_DEK_DELETE" : "DIRECT_DELETE_ROOT_ROW",
        legal_framework: job.legal_framework,
        shredded_at: shreddedAt.toISOString(),
      };
      const signature = await this.signer.sign(certificatePayload);

      await this.repository.transitionJobFromOutbox({
        jobId: input.request_id,
        eventType: input.event_type,
        now,
        shreddedAt,
      });
      await this.repository.insertCertificate({
        requestId: job.id,
        subjectOpaqueId: job.subject_opaque_id,
        method:
          input.event_type === "SHRED_SUCCESS" ? "CRYPTO_SHREDDING_DEK_DELETE" : "DIRECT_DELETE_ROOT_ROW",
        legalFramework: job.legal_framework,
        shreddedAt,
        payload: certificatePayload,
        signatureBase64: signature.signatureBase64,
        publicKeySpkiBase64: signature.publicKeySpkiBase64,
        keyId: signature.keyId,
        algorithm: signature.algorithm,
      });
    } else {
      await this.repository.transitionJobFromOutbox({
        jobId: input.request_id,
        eventType: input.event_type,
        now,
      });
    }

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
