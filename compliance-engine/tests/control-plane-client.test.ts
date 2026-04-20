import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlaneApiClient } from "../src/network/control-plane";

describe("Control Plane API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts offset-form ISO timestamps in worker sync payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        pending: true,
        task: {
          id: "task-notify-1",
          task_type: "NOTIFY_USER",
          payload: {
            request_id: "01ce9849-189c-4c3d-ab91-b35eff852b9f",
            subject_opaque_id: "usr_local_zero",
            idempotency_key: "9943912a-1897-4860-ad9c-d32e9b3c2876",
            trigger_source: "USER_CONSENT_WITHDRAWAL",
            actor_opaque_id: "usr_local_zero",
            legal_framework: "DPDP_2023",
            request_timestamp: "2026-04-20T14:49:04.477+00:00",
            cooldown_days: 0,
            shadow_mode: false,
          },
        },
      }),
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = createControlPlaneApiClient({
      syncUrl: "https://control-plane.example/api/v1/worker/sync",
      ackBaseUrl: "https://control-plane.example/api/v1/worker/tasks",
      workerAuthHeaders: {
        "x-client-id": "worker-1",
        authorization: "Bearer worker-secret",
      },
      pushOutboxEvent: async () => true,
    });

    await expect(client.syncTask()).resolves.toEqual({
      pending: true,
      task: {
        id: "task-notify-1",
        task_type: "NOTIFY_USER",
        payload: {
          request_id: "01ce9849-189c-4c3d-ab91-b35eff852b9f",
          subject_opaque_id: "usr_local_zero",
          idempotency_key: "9943912a-1897-4860-ad9c-d32e9b3c2876",
          trigger_source: "USER_CONSENT_WITHDRAWAL",
          actor_opaque_id: "usr_local_zero",
          legal_framework: "DPDP_2023",
          request_timestamp: "2026-04-20T14:49:04.477+00:00",
          cooldown_days: 0,
          shadow_mode: false,
        },
      },
    });
  });
});
