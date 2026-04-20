import { fail, workerError } from "../errors";
import { getLogger } from "../observability/logger";
import type {
  FetchDispatcherOptions,
  OutboxEvent,
} from "./outbox.shared";

interface ControlPlaneOutboxPayload {
  request_id?: string | null;
  subject_opaque_id?: string | null;
  event_timestamp?: string | null;
  [key: string]: unknown;
}

const logger = getLogger({ component: "outbox" });

function buildControlPlaneRequestBody(event: OutboxEvent) {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    fail({
      code: "DPDP_OUTBOX_PAYLOAD_INVALID",
      title: "Invalid outbox payload",
      detail: `Outbox payload for event ${event.id} must be an object.`,
      category: "integrity",
      retryable: false,
      fatal: true,
      context: { eventId: event.id },
    });
  }

  const payload = event.payload as ControlPlaneOutboxPayload;
  if (!payload.request_id || !payload.subject_opaque_id || !payload.event_timestamp) {
    fail({
      code: "DPDP_OUTBOX_PROTOCOL_REJECTED",
      title: "Outbox payload missing control-plane envelope",
      detail: `Outbox event ${event.id} is missing request_id, subject_opaque_id, or event_timestamp.`,
      category: "integrity",
      retryable: false,
      fatal: true,
      context: { eventId: event.id },
    });
  }

  return {
    idempotency_key: event.idempotency_key,
    request_id: payload.request_id,
    subject_opaque_id: payload.subject_opaque_id,
    event_type: event.event_type,
    payload,
    previous_hash: event.previous_hash,
    current_hash: event.current_hash,
    event_timestamp: payload.event_timestamp,
  };
}

/**
 * No-op dispatcher used by tests and local execution when no HTTP transport is injected.
 *
 * @param event - Outbox event to "send".
 * @returns Always `true` after logging.
 */
export async function sendToAPI(event: OutboxEvent): Promise<boolean> {
  logger.info({ eventId: event.id, eventType: event.event_type }, "Outbox event synced");
  return true;
}

/**
 * Creates an HTTP dispatcher that publishes worker outbox events to the Control Plane.
 *
 * @param options - Endpoint URL, auth headers, and timeout configuration.
 * @returns Dispatcher function compatible with `processOutbox`.
 */
export function createFetchDispatcher(options: FetchDispatcherOptions) {
  const timeoutMs = options.timeoutMs ?? 10_000;

  return async function dispatch(event: OutboxEvent): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const body = buildControlPlaneRequestBody(event);

    try {
      const response = await fetch(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.clientId ? { "x-client-id": options.clientId } : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });

      if (!response.ok) {
        throw workerError({
          code:
            response.status === 401 || response.status === 403
              ? "DPDP_OUTBOX_AUTH_REJECTED"
              : response.status === 429 || response.status >= 500
                ? "DPDP_OUTBOX_DELIVERY_FAILED"
                : "DPDP_OUTBOX_PROTOCOL_REJECTED",
          title:
            response.status === 401 || response.status === 403
              ? "Control Plane authentication rejected outbox event"
              : "Control Plane rejected outbox event",
          detail: `Brain API responded with HTTP ${response.status}.`,
          category:
            response.status === 401 || response.status === 403
              ? "configuration"
              : response.status === 429 || response.status >= 500
                ? "network"
                : "external",
          retryable: response.status >= 500 || response.status === 429,
          fatal: response.status < 500 && response.status !== 429,
          context: {
            status: response.status,
            url: options.url,
          },
        });
      }

      return true;
    } finally {
      clearTimeout(timer);
    }
  };
}
