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
    const seen: string[] = [];
    let releaseA: (result: { valid: boolean }) => void = () => {};
    configureMcpOriginatorKeepaliveForTests({
      verify: (token) => {
        if (token === "mst_a") {
          return new Promise((resolve) => {
            releaseA = resolve;
          });
        }
        seen.push(token);
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
    // The renewal chain must NOT be stranded by the stale verdict's early
    // return (Amelia round-7 P1 r4301745098): a subsequent tick verifies
    // the FRESH token and the chain continues.
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    expect(seen).toEqual(["mst_b"]);
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

describe("round-8: hard bound and stale-error budget guard (evil-shub round-8 P1)", () => {
  afterEach(() => {
    configureMcpOriginatorKeepaliveForTests(null);
    clearMcpOriginatorTokens();
    resetMcpOriginatorAuthority();
  });

  test("a hung verify is rejected by the hard bound and counts one strike, with renewal continuing", async () => {
    // A verify promise that never settles models an OAuth-refresh pre-fetch
    // stuck beneath the abort signal. The tick must not hang forever: the
    // hard bound rejects it as one strike and the entry stays registered.
    configureMcpOriginatorKeepaliveForTests({
      verifyTimeoutMs: 20,
      verify: () => new Promise(() => {}), // never settles
    });
    recordMcpOriginatorDelivery({
      mcp_originator_token: "mst_a",
      super_run_id: "run-a",
      mcp_originator_generation: 1,
    });
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(true);
    await runMcpOriginatorKeepaliveTickForTests("run-a"); // must resolve, not hang
    // Two more hung ticks reach MAX_CONSECUTIVE_FAILURES and stop renewal…
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(false);
  });

  test("a stale token's network failure does not consume the replacement's strike budget", async () => {
    // Install mst_a, start a tick whose verify blocks; while it is in
    // flight a fresh delivery replaces the held token with mst_b; then the
    // in-flight verify rejects. Three such stale errors must NOT reach
    // MAX_CONSECUTIVE_FAILURES against the replacement.
    let release: ((error: Error) => void) | undefined;
    const gates: Array<Promise<void>> = [];
    configureMcpOriginatorKeepaliveForTests({
      verify: (token) =>
        token === "mst_a"
          ? new Promise((_resolve, reject) => {
              gates.push(
                new Promise<void>((done) => {
                  release = (error: Error) => {
                    reject(error);
                    done();
                  };
                }),
              );
            })
          : Promise.resolve({ valid: true }),
    });
    recordMcpOriginatorDelivery({
      mcp_originator_token: "mst_a",
      super_run_id: "run-a",
      mcp_originator_generation: 1,
    });
    for (let i = 0; i < 3; i += 1) {
      const tick = runMcpOriginatorKeepaliveTickForTests("run-a");
      // Replace the held token while the verify is in flight.
      recordMcpOriginatorDelivery({
        mcp_originator_token: "mst_b",
        super_run_id: "run-a",
        mcp_originator_generation: 2 + i,
      });
      release?.(new Error("network down"));
      await tick;
    }
    // The replacement kept its fresh budget: renewal is still registered…
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(true);
    expect(getMcpOriginatorToken("run-a")).toBe("mst_b");
    // …and a clean verify of the replacement resets the (untouched) budget.
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(true);
  });
});

describe("stale in-flight rejection (evil-shub round-9 P1)", () => {
  test("a transport error from a superseded token never charges the replacement's failure budget", async () => {
    const pendingRejects = new Map<string, (error: Error) => void>();
    const seen: string[] = [];
    configureMcpOriginatorKeepaliveForTests({
      verify: (token) => {
        seen.push(token);
        if (token === "mst_4") return Promise.resolve({ valid: true });
        return new Promise((_resolve, reject) => {
          pendingRejects.set(token, reject);
        });
      },
    });
    // Three swap cycles: the tick captures token i and blocks on it; a
    // fresh delivery installs token i+1 mid-flight; then token i's verify
    // rejects with a transport error. Each stale rejection would charge
    // the REPLACEMENT's budget under the old code — three strikes stops
    // renewal for a healthy token.
    for (let i = 1; i <= 3; i += 1) {
      recordMcpOriginatorDelivery({
        mcp_originator_token: `mst_${i}`,
        super_run_id: "run-a",
        mcp_originator_generation: i,
      });
      const tick = runMcpOriginatorKeepaliveTickForTests("run-a");
      recordMcpOriginatorDelivery({
        mcp_originator_token: `mst_${i + 1}`,
        super_run_id: "run-a",
        mcp_originator_generation: i + 1,
      });
      pendingRejects.get(`mst_${i}`)?.(new Error("stale transport boom"));
      await tick;
      expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(true);
    }
    // The final token's budget was never charged: it verifies cleanly and
    // renewal continues (three charged strikes would have stopped it).
    await runMcpOriginatorKeepaliveTickForTests("run-a");
    expect(seen).toContain("mst_4");
    expect(getMcpOriginatorToken("run-a")).toBe("mst_4");
    expect(hasMcpOriginatorKeepaliveForTests("run-a")).toBe(true);
  });
});
