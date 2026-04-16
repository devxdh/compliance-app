import type { JsonObject } from "./common";

/**
 * These are the main data shapes for worker jobs and worker events.
 *
 * Domain models shared across repository, service, controllers, and tests.
 */
export type TaskStatus = "pending" | "claimed" | "completed" | "failed" | "cancelled";
export type TaskAckStatus = "completed" | "failed" | "cancelled";

export interface WorkerTask {
  id: string;
  client_id: string;
  task_type: string;
  payload: JsonObject;
  status: TaskStatus;
  lease_token: string | null;
  lease_expires_at: Date | null;
  claimed_at: Date | null;
  completed_at: Date | null;
  attempt_count: number;
  result: JsonObject | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkerOutboxEvent {
  id: string;
  client_id: string;
  idempotency_key: string | null;
  event_type: string;
  payload: JsonObject;
  received_at: Date;
  processed_at: Date | null;
}
