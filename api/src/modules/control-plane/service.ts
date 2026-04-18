import type { CoeSigner } from "../../crypto/coe";
import type {
  CreateErasureRequestInput,
  WorkerAckInput,
  WorkerOutboxEventInput,
} from "./schemas";
import { ControlPlaneRepository } from "./repository";

interface ServiceOptions {
  repository: ControlPlaneRepository;
  signer: CoeSigner;
  now?: () => Date;
}

/**
 * Domain service for zero-PII control-plane orchestration.
 */
export class ControlPlaneService {
  private readonly now: () => Date;
  private readonly repository: ControlPlaneRepository;
  private readonly signer: CoeSigner;

  constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.signer = options.signer;
    this.now = options.now ?? (() => new Date());
  }

  async createErasureRequest(input: CreateErasureRequestInput) {
    const now = this.now();
    const requestId = `req_${globalThis.crypto.randomUUID()}`;
    const taskId = `task_${globalThis.crypto.randomUUID()}`;

    await this.repository.createRequestWithVaultTask({
      requestId,
      taskId,
      clientId: input.clientId,
      targetHash: input.targetHash,
      legalBasis: input.legalBasis,
      retentionYears: input.retentionYears,
      userId: input.rootUserId ?? 1042,
      now,
    });

    return { requestId, taskId, acceptedAt: now.toISOString() };
  }

  async syncWorker(workerClientId: string) {
    const task = await this.repository.claimNextTask(workerClientId, this.now());

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

  async ingestWorkerOutbox(input: WorkerOutboxEventInput) {
    const now = this.now();
    const request = await this.repository.getRequestById(input.requestId);
    if (!request) {
      throw new Error(`Unknown requestId: ${input.requestId}`);
    }

    if (request.target_hash !== input.targetHash) {
      throw new Error("targetHash does not match registered request.");
    }

    const inserted = await this.repository.recordWorkerOutboxEvent({
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      targetHash: input.targetHash,
      eventType: input.eventType,
      payload: input.payload,
      eventTimestamp: new Date(input.eventTimestamp),
      now,
    });

    if (!inserted) {
      return { accepted: true as const, idempotentReplay: true as const };
    }

    if (input.eventType === "SHRED_SUCCESS") {
      const shreddedAt = new Date(input.eventTimestamp);
      const certificatePayload = {
        requestId: request.id,
        targetHash: request.target_hash,
        method: "CRYPTO_SHREDDING_DEK_DELETE",
        legalFramework: request.legal_basis,
        shreddedAt: shreddedAt.toISOString(),
      };
      const signature = await this.signer.sign(certificatePayload);

      await this.repository.transitionRequestFromOutbox({
        requestId: input.requestId,
        eventType: input.eventType,
        now,
        shreddedAt,
      });
      await this.repository.insertCertificate({
        requestId: request.id,
        targetHash: request.target_hash,
        shreddedAt,
        payload: certificatePayload,
        signatureBase64: signature.signatureBase64,
        publicKeySpkiBase64: signature.publicKeySpkiBase64,
        keyId: signature.keyId,
        algorithm: signature.algorithm,
      });
    } else {
      await this.repository.transitionRequestFromOutbox({
        requestId: input.requestId,
        eventType: input.eventType,
        now,
      });
    }

    return { accepted: true as const, idempotentReplay: false as const };
  }

  async getCertificate(requestId: string) {
    return this.repository.getCertificateByRequestId(requestId);
  }
}

