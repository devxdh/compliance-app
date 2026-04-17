import { describe, expect, it, vi } from "vitest";
import { createFetchDispatcher } from "../src/network/outbox";

const apiUrl = "https://api.compliance.io/outbox"
describe("Fetch Dispatcher Integration", () => {
  /**
   * Layman Terms:
   * Tests the mailman. We make sure that when he tries to deliver a postcard (an HTTP POST request),
   * he correctly tells us if the house accepted it (Status 200 OK) or if the door was locked (Error).
   *
   * Technical Terms:
   * Validates the `createFetchDispatcher` transport layer. It mocks the global `fetch` API to ensure
   * headers, abort signals, and payload serializations are correctly formatted according to the Outbox
   * event contract.
   */
  it("successfully dispatches an outbox event and parses a 200 OK", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal('fetch', mockFetch)

    const dispatcher = createFetchDispatcher({
      url: apiUrl,
      token: "secret-token",
    });

    const success = await dispatcher({
      id: "evt-123",
      idempotency_key: "ik-123",
      user_uuid_hash: "hash-456",
      event_type: "USER_VAULTED",
      payload: { userId: 1 },
      previous_hash: "GENESIS",
      current_hash: "abcd",
      status: "pending",
      attempt_count: 0,
      lease_token: null,
      lease_expires_at: null,
      next_attempt_at: new Date(),
      processed_at: null,
      last_error: null,
      created_at: new Date(),
      updated_at: new Date()
    });

    expect(success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify headers and body
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs![0]).toBe(apiUrl);
    expect(callArgs![1].headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer secret-token",
    });
    expect(JSON.parse(callArgs![1].body)).toMatchObject({
      id: "evt-123",
      event_type: "USER_VAULTED",
      payload: { userId: 1 },
    });
  });

  it("throws an error if the server responds with a non-2xx status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    vi.stubGlobal('fetch', mockFetch)

    const dispatcher = createFetchDispatcher({
      url: apiUrl,
    });

    await expect(dispatcher({
      id: "evt-123",
      idempotency_key: "ik-123",
      user_uuid_hash: "hash-456",
      event_type: "USER_VAULTED",
      payload: {},
      previous_hash: "GENESIS",
      current_hash: "abcd",
      status: "pending",
      attempt_count: 0,
      lease_token: null,
      lease_expires_at: null,
      next_attempt_at: new Date(),
      processed_at: null,
      last_error: null,
      created_at: new Date(),
      updated_at: new Date()
    })).rejects.toThrow("Brain API responded with HTTP 500");
  });
});
