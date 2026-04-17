import { beforeEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";

const getDependencyGraphMock = vi.fn();

vi.mock("../src/db/graph", () => ({
  getDependencyGraph: getDependencyGraphMock,
}));

const { vaultUser } = await import("../src/engine/vault");

describe("Vault Engine Replica Routing", () => {
  beforeEach(() => {
    getDependencyGraphMock.mockReset();
    getDependencyGraphMock.mockResolvedValue([]);
  });

  it("uses the replica handle for dry-run graph traversal when provided", async () => {
    const primary = {
      unsafe: vi.fn().mockResolvedValue([]),
    } as unknown as postgres.Sql;
    const replica = {
      tag: "replica",
    } as unknown as postgres.Sql;

    const result = await vaultUser(
      primary,
      42,
      {
        kek: new Uint8Array(32).fill(0x42),
        hmacKey: new Uint8Array(32).fill(0x24),
      },
      {
        appSchema: "tenant_app",
        engineSchema: "tenant_engine",
        dryRun: true,
        sqlReplica: replica,
        now: new Date("2026-01-10T00:00:00.000Z"),
      }
    );

    expect(result.action).toBe("dry_run");
    expect(getDependencyGraphMock).toHaveBeenCalledWith(replica, "tenant_app", "users", { maxDepth: 32 });
  });
});
