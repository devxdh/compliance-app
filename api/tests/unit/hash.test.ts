import { describe, expect, it } from "vitest";
import { computeTokenHash, computeWormHash } from "../../src/modules/control-plane/hash";

describe("Control Plane Hashing", () => {
  it("computes deterministic SHA-256 token hashes", async () => {
    const digest = await computeTokenHash("worker-secret");
    expect(digest).toBe("6fb46f7a92742970166379ed5195e79c4493a7cc5664280c039cfd4095ba5faf");
  });

  it("computes deterministic WORM chain hashes", async () => {
    const digest = await computeWormHash("GENESIS", { eventType: "USER_VAULTED" });
    expect(digest).toBe("16efd736c8b552bc17934e1c6ae2bc4f0b4d2b7bab4773a445cfe486b16663c1");
  });
});
