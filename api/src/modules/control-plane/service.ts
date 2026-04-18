import type { CoeSigner } from "../../crypto/coe";
import { computeTokenHash, computeWormHash } from "./hash";
import { ControlPlaneRepository } from "./repository";
import type { CreateErasureRequestInput, WorkerAckInput, WorkerOutboxEventInput } from "./schemas";

interface ServiceOptions {
  repository: ControlPlaneRepository;
  signer: CoeSigner;
  workerSharedSecret: string;
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
  private readonly maxOutboxPayloadBytes: number;

  constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.signer = options.signer;
    this.workerSharedSecret = options.workerSharedSecret;
    this.maxOutboxPayloadBytes = options.maxOutboxPayloadBytes;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Builds the canonical audit payload that is persisted in the WORM ledger.
   */
  private buildOutboxPayload(input: WorkerOutboxEventInput) {
    return {
      requestId: input.requestId,
      targetHash: input.targetHash,
      eventTimestamp: input.eventTimestamp,
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

    if (existing.event_type !== input.eventType) {
      return false;
    }

    if (existing.previous_hash !== input.previousHash || existing.current_hash !== input.currentHash) {
      return false;
    }

    return (
      JSON.stringify(this.canonicalizeJson(existing.payload)) ===
      JSON.stringify(this.canonicalizeJson(this.buildOutboxPayload(input)))
    );
  }

  /**
   * Registers an erasure request and queues the first worker task.
   */
  async createErasureRequest(input: CreateErasureRequestInput) {
    const now = this.now();
    const jobId = globalThis.crypto.randomUUID();
    const taskId = globalThis.crypto.randomUUID();
    const tokenHash = await computeTokenHash(this.workerSharedSecret);
    const client = await this.repository.ensureClient(input.clientId, tokenHash);

    await this.repository.createJobAndQueueTask({
      jobId,
      taskId,
      clientId: client.id,
      clientInternalUserId: (input.rootUserId ?? 1042).toString(),
      userUuidHash: input.targetHash,
      legalBasis: input.legalBasis,
      retentionYears: input.retentionYears,
      payload: { userId: input.rootUserId ?? 1042 },
      now,
    });

    return { requestId: jobId, taskId, acceptedAt: now.toISOString() };
  }

  /**
   * Authenticates a worker using client name + bearer token hash matching.
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
   * Finalizes an active worker task and advances the erasure job state machine.
   */
  async ackWorkerTask(taskId: string, input: WorkerAckInput) {
    const task = await this.repository.ackTask(taskId, input.status, input.result, this.now());
    if (!task) {
      return null;
    }

    return {
      taskId: task.id,
      status: task.status,
    };
  }

  /**
   * Ingests worker outbox events with chain validation and idempotent replay handling.
   */
  async ingestWorkerOutbox(input: WorkerOutboxEventInput, clientId: string) {
    const now = this.now();
    const existingEvent = await this.repository.getAuditEventByIdempotencyKey(input.idempotencyKey);
    if (existingEvent) {
      if (this.isReplayEquivalent(existingEvent, input, clientId)) {
        return { accepted: true as const, idempotentReplay: true as const };
      }

      throw new Error("idempotencyKey already exists with a different event payload.");
    }

    const job = await this.repository.getJobById(input.requestId);
    if (!job) {
      throw new Error(`Unknown requestId: ${input.requestId}`);
    }

    if (job.client_id !== clientId) {
      throw new Error("worker is not authorized for this request.");
    }

    if (job.user_uuid_hash !== input.targetHash) {
      throw new Error("targetHash does not match registered request.");
    }

    const payloadBytes = new TextEncoder().encode(JSON.stringify(input.payload)).byteLength;
    if (payloadBytes > this.maxOutboxPayloadBytes) {
      throw new Error(`outbox payload exceeds ${this.maxOutboxPayloadBytes} bytes.`);
    }

    const latestHash = (await this.repository.getLatestAuditHash(clientId)) ?? "GENESIS";
    if (input.previousHash !== latestHash) {
      throw new Error("previousHash does not match the latest audit ledger hash.");
    }

    const expectedCurrentHash = await computeWormHash(input.previousHash, input.payload);
    if (expectedCurrentHash !== input.currentHash) {
      throw new Error("currentHash is invalid for the provided payload chain.");
    }

    const outboxPayload = this.buildOutboxPayload(input);
    const inserted = await this.repository.insertAuditLedgerEvent({
      clientId,
      idempotencyKey: input.idempotencyKey,
      eventType: input.eventType,
      payload: outboxPayload,
      previousHash: input.previousHash,
      currentHash: input.currentHash,
      now,
    });

    if (!inserted) {
      const racedEvent = await this.repository.getAuditEventByIdempotencyKey(input.idempotencyKey);
      if (racedEvent && this.isReplayEquivalent(racedEvent, input, clientId)) {
        return { accepted: true as const, idempotentReplay: true as const };
      }

      throw new Error("idempotencyKey conflict detected for a non-equivalent event.");
    }

    if (input.eventType === "SHRED_SUCCESS") {
      const shreddedAt = new Date(input.eventTimestamp);
      const certificatePayload = {
        requestId: job.id,
        targetHash: job.user_uuid_hash,
        method: "CRYPTO_SHREDDING_DEK_DELETE",
        legalFramework: job.legal_basis,
        shreddedAt: shreddedAt.toISOString(),
      };
      const signature = await this.signer.sign(certificatePayload);

      await this.repository.transitionJobFromOutbox({
        jobId: input.requestId,
        eventType: input.eventType,
        now,
        shreddedAt,
      });
      await this.repository.insertCertificate({
        requestId: job.id,
        targetHash: job.user_uuid_hash,
        shreddedAt,
        payload: certificatePayload,
        signatureBase64: signature.signatureBase64,
        publicKeySpkiBase64: signature.publicKeySpkiBase64,
        keyId: signature.keyId,
        algorithm: signature.algorithm,
      });
    } else {
      await this.repository.transitionJobFromOutbox({
        jobId: input.requestId,
        eventType: input.eventType,
        now,
      });
    }

    return { accepted: true as const, idempotentReplay: false as const };
  }

  /**
   * Fetches a minted Certificate of Erasure by request id.
   */
  async getCertificate(requestId: string) {
    return this.repository.getCertificateByRequestId(requestId);
  }
}
