import { fail } from "../../../errors";
import {
  canonicalJsonStringify,
  computeTokenHash,
  computeWormHash,
} from "../hash";
import { ControlPlaneRepository } from "../repository";
import type {
  CreateErasureRequestInput,
  WorkerAckInput,
  WorkerOutboxEventInput,
} from "../schemas";
import {
  assertAllowedOutboxTransition,
  assertOutboxMetadata,
  buildOutboxPayload,
  isCreateRequestEquivalent,
  parseVaultLifecyclePolicy,
  isReplayEquivalent,
  parseVaultLifecycleSchedule,
} from "./guards";
import { finalizeTerminalOutboxEvent, isTerminalEventType } from "./terminal";
import type { ServiceOptions } from "./types";
import { assertSafeWebhookUrl } from "../webhook";
import { recordUsageEvent, recordWorkerOutboxEvent } from "../../../observability/metrics";

/**
 * Domain service for zero-PII control-plane orchestration.
 */
export class ControlPlaneService {
  private readonly now: () => Date;
  private readonly repository: ControlPlaneRepository;
  private readonly signer: ServiceOptions["signer"];
  private readonly workerSharedSecret: string;
  private readonly workerClientName: string;
  private readonly maxOutboxPayloadBytes: number;
  private readonly webhookTimeoutMs: number;
  private readonly shadowBurnInRequired: boolean;
  private readonly shadowRequiredSuccesses: number;

  constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.signer = options.signer;
    this.workerSharedSecret = options.workerSharedSecret;
    this.workerClientName = options.workerClientName;
    this.maxOutboxPayloadBytes = options.maxOutboxPayloadBytes;
    this.webhookTimeoutMs = options.webhookTimeoutMs ?? 10_000;
    this.shadowBurnInRequired = options.shadowBurnInRequired ?? true;
    this.shadowRequiredSuccesses = options.shadowRequiredSuccesses ?? 100;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Applies deterministic Control Plane state transitions for a committed worker outbox event.
   *
   * This method is replay-safe. If the API crashes after appending the WORM ledger but before
   * updating the state machine, a worker retry must be able to restore the same lifecycle
   * transition without duplicating downstream work.
   *
   * @param job - Existing erasure job.
   * @param input - Validated worker outbox event.
   * @param now - Request clock anchor.
   */
  private async applyOutboxLifecycle(
    job: Awaited<ReturnType<ControlPlaneRepository["getJobById"]>> extends infer T
      ? Exclude<T, null>
      : never,
    input: WorkerOutboxEventInput,
    now: Date
  ): Promise<void> {
    const schedule =
      input.event_type === "USER_VAULTED"
        ? parseVaultLifecycleSchedule(input.payload)
        : null;
    const policy =
      input.event_type === "USER_VAULTED" || input.event_type === "USER_HARD_DELETED"
        ? parseVaultLifecyclePolicy(input.payload)
        : null;
    const shreddedAt = isTerminalEventType(input.event_type)
      ? new Date(input.event_timestamp)
      : undefined;

    await this.repository.transitionJobFromOutbox({
      jobId: input.request_id,
      eventType: input.event_type,
      now,
      notificationDueAt: schedule?.notificationDueAt,
      shredDueAt: schedule?.shredDueAt,
      shreddedAt,
      appliedRuleName: policy?.appliedRuleName,
      appliedRuleCitation: policy?.appliedRuleCitation,
    });

    if (isTerminalEventType(input.event_type)) {
      await finalizeTerminalOutboxEvent(
        this.repository,
        this.signer,
        this.webhookTimeoutMs,
        job,
        input.event_type,
        shreddedAt!,
        input.current_hash
      );
    }
  }

  /**
   * Registers an erasure request and queues the first worker task.
   *
   * @param input - Validated erasure ingestion payload.
   * @returns Request/task identifiers plus idempotent replay indicator.
   * @throws {ApiError} When the idempotency key is reused with a different payload.
   */
  async createErasureRequest(input: CreateErasureRequestInput) {
    if (input.webhook_url) {
      assertSafeWebhookUrl(input.webhook_url);
    }

    const existingJob = await this.repository.getJobByIdempotencyKey(
      input.idempotency_key
    );
    if (existingJob) {
      if (!isCreateRequestEquivalent(existingJob, input)) {
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
    const client = await this.repository.ensureClient(
      this.workerClientName,
      tokenHash
    );
    if (!client.is_active) {
      fail({
        code: "API_WORKER_CLIENT_INACTIVE",
        title: "Configured worker client is inactive",
        detail: `Worker client ${this.workerClientName} is disabled and cannot accept new erasure jobs.`,
        status: 409,
        category: "configuration",
        retryable: false,
      });
    }

    if (
      this.shadowBurnInRequired &&
      this.shadowRequiredSuccesses > 0 &&
      !input.shadow_mode &&
      !client.live_mutation_enabled
    ) {
      fail({
        code: "API_LIVE_MUTATION_BURN_IN_REQUIRED",
        title: "Shadow-mode burn-in required",
        detail: `Worker client ${client.name} must complete ${this.shadowRequiredSuccesses} successful shadow-mode vault tasks before live mutation. Current successes: ${client.shadow_success_count}.`,
        status: 409,
        category: "configuration",
        retryable: false,
        context: {
          clientName: client.name,
          currentSuccesses: client.shadow_success_count,
          requiredSuccesses: this.shadowRequiredSuccesses,
        },
      });
    }

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
   * Authenticates a worker using client name plus bearer-token hash matching.
   *
   * @param clientName - Worker client name from the request header.
   * @param bearerToken - Raw bearer token.
   * @returns Worker client id when credentials match, otherwise `null`.
   */
  async authorizeWorker(
    clientName: string,
    bearerToken: string
  ): Promise<string | null> {
    const client = await this.repository.getClientByName(clientName);
    if (!client || !client.is_active) {
      return null;
    }

    const tokenHash = await computeTokenHash(bearerToken);
    if (tokenHash !== client.worker_api_key_hash) {
      return null;
    }

    await this.repository.touchClientAuthentication(client.id, this.now());
    return client.id;
  }

  /**
   * Leases at most one pending task for the authenticated worker.
   *
   * @param clientName - Worker client name for lease attribution.
   * @param clientId - Authenticated worker client id.
   * @param heartbeat - Worker config fingerprint metadata from sync headers.
   * @returns Pending task envelope or `pending: false`.
   */
  async syncWorker(
    clientName: string,
    clientId: string,
    heartbeat: { configHash: string; configVersion?: string; dpoIdentifier?: string }
  ) {
    await this.repository.insertWorkerConfigHeartbeat({
      clientId,
      configHash: heartbeat.configHash,
      configVersion: heartbeat.configVersion,
      dpoIdentifier: heartbeat.dpoIdentifier,
      now: this.now(),
    });

    const task = await this.repository.claimNextTask(
      clientId,
      clientName,
      this.now()
    );

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

    const cancelled = await this.repository.cancelWaitingJobByIdempotencyKey(
      idempotencyKey,
      this.now()
    );
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
    const now = this.now();
    const task = await this.repository.ackTask(
      taskId,
      input.status,
      input.result,
      now
    );
    if (!task) {
      return null;
    }

    if (
      input.status === "completed" &&
      task.task_type === "VAULT_USER" &&
      task.status === "COMPLETED" &&
      task.payload.shadow_mode === true &&
      this.shadowRequiredSuccesses > 0
    ) {
      await this.repository.recordShadowVaultSuccessForTask(
        task.id,
        task.client_id,
        this.shadowRequiredSuccesses,
        now
      );
    }

    return {
      task_id: task.id,
      status: task.status,
    };
  }

  /**
   * Ingests worker outbox events with chain validation and idempotent replay handling.
   *
   * @param input - Validated outbox event from the worker.
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

    assertOutboxMetadata(job, input);

    const existingEvent = await this.repository.getAuditEventByIdempotencyKey(
      input.idempotency_key
    );
    if (existingEvent) {
      if (isReplayEquivalent(existingEvent, input, clientId)) {
        await this.applyOutboxLifecycle(job, input, now);
        const usageInserted = await this.repository.insertUsageEvent({
          billingKey: `outbox:${input.idempotency_key}`,
          clientId,
          erasureJobId: job.id,
          eventType: input.event_type,
          units: 1,
          metadata: {
            replay: true,
          },
          occurredAt: now,
        });
        recordWorkerOutboxEvent(input.event_type, "replay");
        recordUsageEvent(input.event_type, usageInserted ? "inserted" : "replay");
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

    assertAllowedOutboxTransition(job, input.event_type);

    const payloadBytes = new TextEncoder().encode(
      canonicalJsonStringify(input.payload)
    ).byteLength;
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

    const expectedCurrentHash = await computeWormHash(
      input.previous_hash,
      input.payload,
      input.idempotency_key
    );
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

    const inserted = await this.repository.insertAuditLedgerEvent({
      clientId,
      idempotencyKey: input.idempotency_key,
      eventType: input.event_type,
      payload: buildOutboxPayload(input),
      previousHash: input.previous_hash,
      currentHash: input.current_hash,
      now,
    });

    if (!inserted) {
      const racedEvent = await this.repository.getAuditEventByIdempotencyKey(
        input.idempotency_key
      );
      if (racedEvent && isReplayEquivalent(racedEvent, input, clientId)) {
        await this.applyOutboxLifecycle(job, input, now);
        const usageInserted = await this.repository.insertUsageEvent({
          billingKey: `outbox:${input.idempotency_key}`,
          clientId,
          erasureJobId: job.id,
          eventType: input.event_type,
          units: 1,
          metadata: {
            replay: true,
          },
          occurredAt: now,
        });
        recordWorkerOutboxEvent(input.event_type, "replay");
        recordUsageEvent(input.event_type, usageInserted ? "inserted" : "replay");
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
    const usageInserted = await this.repository.insertUsageEvent({
      billingKey: `outbox:${input.idempotency_key}`,
      clientId,
      erasureJobId: job.id,
      eventType: input.event_type,
      units: 1,
      metadata: {
        current_hash: input.current_hash,
      },
      occurredAt: now,
    });
    recordWorkerOutboxEvent(input.event_type, "accepted");
    recordUsageEvent(input.event_type, usageInserted ? "inserted" : "replay");

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
