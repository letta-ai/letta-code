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
});
