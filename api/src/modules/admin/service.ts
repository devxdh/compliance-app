import { fail } from "../../errors";
import { computeTokenHash } from "../control-plane/hash";
import type { ControlPlaneRepository } from "../control-plane/repository";
import type {
  AdminAuditExportQueryInput,
  AdminCreateClientInput,
  AdminUsageQueryInput,
} from "./schemas";

export interface AdminServiceOptions {
  repository: ControlPlaneRepository;
  now?: () => Date;
}

/**
 * Operator-facing service for client lifecycle, DLQ recovery, usage reporting, and audit export.
 */
export class AdminService {
  private readonly repository: ControlPlaneRepository;
  private readonly now: () => Date;

  constructor(options: AdminServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Lists registered worker clients with their current auth and activity metadata.
   *
   * @returns Persisted worker clients.
   */
  async listClients() {
    return this.repository.listClients();
  }

  /**
   * Creates a new worker client and returns its one-time raw token.
   *
   * @param input - Client identity metadata.
   * @returns Persisted client metadata plus the issued raw bearer token.
   * @throws {ApiError} When the client name already exists.
   */
  async createClient(input: AdminCreateClientInput) {
    const existing = await this.repository.getClientByName(input.name);
    if (existing) {
      fail({
        code: "API_ADMIN_CLIENT_EXISTS",
        title: "Client already exists",
        detail: `Worker client ${input.name} already exists.`,
        status: 409,
        category: "integrity",
        retryable: false,
      });
    }

    const rawToken = `wkr_${globalThis.crypto.randomUUID()}`;
    const currentKeyId = `key_${globalThis.crypto.randomUUID()}`;
    const now = this.now();
    const client = await this.repository.createClient({
      name: input.name,
      displayName: input.display_name ?? null,
      workerApiKeyHash: await computeTokenHash(rawToken),
      currentKeyId,
      now,
    });

    return {
      client,
      bearer_token: rawToken,
    };
  }

  /**
   * Rotates the raw bearer token for an existing worker client.
   *
   * @param name - Stable worker client name.
   * @returns Updated client metadata plus the one-time replacement token.
   * @throws {ApiError} When the client does not exist.
   */
  async rotateClientKey(name: string) {
    const rawToken = `wkr_${globalThis.crypto.randomUUID()}`;
    const currentKeyId = `key_${globalThis.crypto.randomUUID()}`;
    const client = await this.repository.rotateClientKey({
      name,
      workerApiKeyHash: await computeTokenHash(rawToken),
      currentKeyId,
      now: this.now(),
    });

    if (!client) {
      fail({
        code: "API_ADMIN_CLIENT_NOT_FOUND",
        title: "Client not found",
        detail: `Worker client ${name} does not exist.`,
        status: 404,
        category: "validation",
        retryable: false,
      });
    }

    return {
      client,
      bearer_token: rawToken,
    };
  }

  /**
   * Disables a worker client without deleting its audit history.
   *
   * @param name - Stable worker client name.
   * @returns Updated client row.
   * @throws {ApiError} When the client does not exist.
   */
  async deactivateClient(name: string) {
    const client = await this.repository.setClientActiveState(name, false);
    if (!client) {
      fail({
        code: "API_ADMIN_CLIENT_NOT_FOUND",
        title: "Client not found",
        detail: `Worker client ${name} does not exist.`,
        status: 404,
        category: "validation",
        retryable: false,
      });
    }
    return client;
  }

  /**
   * Lists dead-letter tasks currently requiring operator review.
   *
   * @returns Dead-letter task rows.
   */
  async listDeadLetters() {
    return this.repository.listDeadLetterTasks();
  }

  /**
   * Requeues a dead-letter task for another execution attempt.
   *
   * @param taskId - Dead-letter task UUID.
   * @returns Updated task row.
   * @throws {ApiError} When the task is missing or not dead-lettered.
   */
  async requeueDeadLetter(taskId: string) {
    const task = await this.repository.requeueDeadLetterTask(taskId, this.now());
    if (!task) {
      fail({
        code: "API_ADMIN_DEAD_LETTER_NOT_FOUND",
        title: "Dead-letter task not found",
        detail: `Dead-letter task ${taskId} does not exist or is no longer recoverable.`,
        status: 404,
        category: "validation",
        retryable: false,
      });
    }
    return task;
  }

  /**
   * Aggregates usage totals for lightweight billing and operations reporting.
   *
   * @param query - Optional client/time filters.
   * @returns Usage summary rows.
   */
  async summarizeUsage(query: AdminUsageQueryInput) {
    return this.repository.summarizeUsage({
      clientName: query.client_name,
      since: query.since ? new Date(query.since) : undefined,
      until: query.until ? new Date(query.until) : undefined,
    });
  }

  /**
   * Exports ordered audit ledger rows for archival and external WORM replication.
   *
   * @param query - Optional client/sequence filters.
   * @returns Ordered audit ledger rows.
   */
  async exportAuditLedger(query: AdminAuditExportQueryInput) {
    return this.repository.listAuditLedgerEvents({
      clientName: query.client_name,
      afterLedgerSeq: query.after_ledger_seq,
    });
  }
}
