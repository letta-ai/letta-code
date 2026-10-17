import { afterEach, describe, expect, test } from "bun:test";
import { resetMcpOriginatorAuthority } from "./mcp-originator-authority";
import {
  configureMcpOriginatorKeepaliveForTests,
  hasMcpOriginatorKeepaliveForTests,
  runMcpOriginatorKeepaliveTickForTests,
} from "./mcp-originator-keepalive";
import {
  clearMcpOriginatorTokens,
  getMcpOriginatorToken,
  recordMcpOriginatorDelivery,
} from "./mcp-originator-tokens";

afterEach(() => {
  configureMcpOriginatorKeepaliveForTests(null);
  clearMcpOriginatorTokens();
  resetMcpOriginatorAuthority();
});

describe("MCP originator keepalive", () => {
  test("installing a token entry registers renewal, and a tick verifies it", async () => {
    const seen: string[] = [];
    configureMcpOriginatorKeepaliveForTests({
      verify: async (token) => {
        seen.push(token);
        return { valid: true };
      },
    });
    recordMcpOriginatorDelivery({
      mcp_originator_token: "mst_a",
      super_run_id: "run-a",
      mcp_originator_generation: 1,
    });
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(true);
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    expect(seen).toEqual(["mst_a"]);
    expect(getMcpOriginatorToken("run-a")).toBe("mst_a");
  });

  test("a server denial withdraws the entry and stops renewal", async () => {
    let calls = 0;
    configureMcpOriginatorKeepaliveForTests({
      verify: async () => {
        calls += 1;
        return { valid: false };
      },
    });
    recordMcpOriginatorDelivery({
      mcp_originator_token: "mst_a",
      super_run_id: "run-a",
      mcp_originator_generation: 1,
    });
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    expect(getMcpOriginatorToken("run-a")).toBeUndefined();
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(false);
    expect(calls).toBe(1);
  });

  test("transient failures keep the token but stop renewal after three strikes", async () => {
    let calls = 0;
    configureMcpOriginatorKeepaliveForTests({
      verify: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    recordMcpOriginatorDelivery({
      mcp_originator_token: "mst_a",
      super_run_id: "run-a",
      mcp_originator_generation: 1,
    });
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(true);
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    // Renewal gave up loudly; the local token remains until its own
    // lifecycle (tombstone/retirement/expiry) removes it.
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(false);
    expect(calls).toBe(3);
  });

  test("a tombstone stops renewal without touching the server", async () => {
    let calls = 0;
    configureMcpOriginatorKeepaliveForTests({
      verify: async () => {
        calls += 1;
        return { valid: true };
      },
    });
    recordMcpOriginatorDelivery({
      mcp_originator_token: "mst_a",
      super_run_id: "run-a",
      mcp_originator_generation: 1,
    });
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(true);
    recordMcpOriginatorDelivery({
      mcp_originator_token: null,
      super_run_id: "run-a",
      mcp_originator_generation: 1,
    });
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(false);
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    expect(calls).toBe(0);
  });

  test("a run with no entry never verifies", async () => {
    let calls = 0;
    configureMcpOriginatorKeepaliveForTests({
      verify: async () => {
        calls += 1;
        return { valid: true };
      },
    });
    await runMcpOriginatorKeepaliveTickForTests("run-ghost");
    expect(calls).toBe(0);
    expect(hasMcpOriginatorKeepaliveForTests("run-ghost")).toBe(false);
  });

  test("a stale verdict for a superseded token cannot withdraw the fresh one", async () => {
    // evil-shub round-6 P1: verify(A) is in flight when a re-mint installs
    // B; A's { valid: false } (expected — the producer revoked A) must not
    // withdraw B. Withdrawal is gated on the store still holding the exact
    // verified token.
    let releaseA: (result: { valid: boolean }) => void = () => {};
    configureMcpOriginatorKeepaliveForTests({
      verify: (token) => {
        if (token === "mst_a") {
          return new Promise((resolve) => {
            releaseA = resolve;
          });
        }
        return Promise.resolve({ valid: true });
      },
    });
    recordMcpOriginatorDelivery({
      mcp_originator_token: "mst_a",
      super_run_id: "run-a",
      mcp_originator_generation: 1,
    });
    const inflightTick = runMcpOriginatorKeepaliveTickForTests("run-a");
    // The tick for A is now parked inside verify. A fresh delivery installs
    // B (the producer re-minted and revoked A).
    recordMcpOriginatorDelivery({
      mcp_originator_token: "mst_b",
      super_run_id: "run-a",
      mcp_originator_generation: 2,
    });
    releaseA({ valid: false });
    await inflightTick;
    expect(getMcpOriginatorToken("run-a")).toBe("mst_b");
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(true);
  });

  test("a stale verdict CAN still withdraw when the verified token is still held", async () => {
    let releaseA: (result: { valid: boolean }) => void = () => {};
    configureMcpOriginatorKeepaliveForTests({
      verify: () =>
        new Promise((resolve) => {
          releaseA = resolve;
        }),
    });
    recordMcpOriginatorDelivery({
      mcp_originator_token: "mst_a",
      super_run_id: "run-a",
      mcp_originator_generation: 1,
    });
    const inflightTick = runMcpOriginatorKeepaliveTickForTests("run-a");
    releaseA({ valid: false });
    await inflightTick;
    expect(getMcpOriginatorToken("run-a")).toBeUndefined();
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(false);
  });

  test("re-installing a token resets the failure budget", async () => {
    // evil-shub round-6 P1: strikes against the old token must not bleed
    // into the replacement's renewal budget.
    let calls = 0;
    configureMcpOriginatorKeepaliveForTests({
      verify: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    recordMcpOriginatorDelivery({
      mcp_originator_token: "mst_a",
      super_run_id: "run-a",
      mcp_originator_generation: 1,
    });
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(true);
    // Fresh delivery: the failure counter resets.
    recordMcpOriginatorDelivery({
      mcp_originator_token: "mst_b",
      super_run_id: "run-a",
      mcp_originator_generation: 2,
    });
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    // Two strikes against B: renewal must still be armed.
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(true);
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(false);
    expect(calls).toBe(5);
  });
});
