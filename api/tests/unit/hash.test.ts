import { describe, expect, it } from "vitest";
import { computeTokenHash, computeWormHash } from "../../src/modules/control-plane/hash";

describe("Control Plane Hashing", () => {
  it("computes deterministic SHA-256 token hashes", async () => {
    const digest = await computeTokenHash("worker-secret");
    expect(digest).toBe("6fb46f7a92742970166379ed5195e79c4493a7cc5664280c039cfd4095ba5faf");
  });

  it("computes deterministic WORM chain hashes", async () => {
    const digest = await computeWormHash("GENESIS", { eventType: "USER_VAULTED" }, "vault:req-123");
    expect(digest).toBe("045388e3f0c1b30c0eb88ff5deed1f66f78450cae0ab7e80da649f8553d74365");
  });

  it("canonicalizes payload key ordering before hashing", async () => {
    const left = await computeWormHash(
      "GENESIS",
      { b: "second", a: "first", nested: { y: 2, x: 1 } },
      "vault:req-ordered"
    );
    const right = await computeWormHash(
      "GENESIS",
      { nested: { x: 1, y: 2 }, a: "first", b: "second" },
      "vault:req-ordered"
    );
    expect(left).toBe(right);
  });
});
