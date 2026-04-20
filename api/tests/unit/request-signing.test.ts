import { describe, expect, it } from "vitest";
import { computeRequestSignature } from "../../src/http/request-signing";

describe("worker request signing", () => {
  it("computes deterministic HMAC signatures for identical request envelopes", async () => {
    const left = await computeRequestSignature(
      "signing-secret",
      "POST",
      "/api/v1/worker/outbox",
      "worker-1",
      "1713600000000",
      '{"hello":"world"}'
    );
    const right = await computeRequestSignature(
      "signing-secret",
      "POST",
      "/api/v1/worker/outbox",
      "worker-1",
      "1713600000000",
      '{"hello":"world"}'
    );
    expect(left).toBe(right);
  });
});
