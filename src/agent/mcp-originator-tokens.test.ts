import { afterEach, describe, expect, test } from "bun:test";
import {
  clearMcpOriginatorTokens,
  deleteMcpOriginatorToken,
  getMcpOriginatorToken,
  mcpOriginatorTokenCount,
  readMcpOriginatorDelivery,
  recordMcpOriginatorDelivery,
  retireMcpOriginatorTokensOnOriginSwap,
  setMcpOriginatorToken,
} from "./mcp-originator-tokens";

describe("MCP originator token store", () => {
  afterEach(() => {
    clearMcpOriginatorTokens();
  });

  test("stores and resolves a token keyed by super run id", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-a");
    expect(mcpOriginatorTokenCount()).toBe(1);
  });

  test("never leaks a token across super runs", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    setMcpOriginatorToken("sr-2", "mst_two.secret-b");
    expect(getMcpOriginatorToken("sr-2")).toBe("mst_two.secret-b");
    expect(getMcpOriginatorToken("sr-3")).toBeUndefined();
    deleteMcpOriginatorToken("sr-1");
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    expect(getMcpOriginatorToken("sr-2")).toBe("mst_two.secret-b");
  });

  test("a re-delivered run replaces its older token", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    setMcpOriginatorToken("sr-1", "mst_one.secret-c");
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-c");
  });

  test("resolving a missing or empty super run id yields nothing", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    expect(getMcpOriginatorToken(undefined)).toBeUndefined();
    expect(getMcpOriginatorToken(null)).toBeUndefined();
    expect(getMcpOriginatorToken("")).toBeUndefined();
  });

  test("clearing the store drops every run's token", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    setMcpOriginatorToken("sr-2", "mst_two.secret-b");
    clearMcpOriginatorTokens();
    expect(mcpOriginatorTokenCount()).toBe(0);
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    expect(getMcpOriginatorToken("sr-2")).toBeUndefined();
  });
});

describe("readMcpOriginatorDelivery", () => {
  test("parses a complete delivery", () => {
    expect(
      readMcpOriginatorDelivery({
        super_run_id: "sr-1",
        mcp_originator_token: "mst_one.secret-a",
      }),
    ).toEqual({ superRunId: "sr-1", token: "mst_one.secret-a" });
  });

  test("treats a missing token as an unattributed delivery", () => {
    expect(readMcpOriginatorDelivery({ super_run_id: "sr-1" })).toEqual({
      superRunId: "sr-1",
    });
    expect(readMcpOriginatorDelivery({})).toEqual({});
  });

  test("ignores malformed wire values instead of trusting them", () => {
    expect(
      readMcpOriginatorDelivery({
        super_run_id: 42 as unknown as string,
        mcp_originator_token: "mst_one.secret-a",
      }),
    ).toEqual({ token: "mst_one.secret-a" });
    expect(
      readMcpOriginatorDelivery({
        super_run_id: "sr-1",
        mcp_originator_token: "",
      }),
    ).toEqual({ superRunId: "sr-1" });
  });
});

describe("recordMcpOriginatorDelivery", () => {
  afterEach(() => {
    clearMcpOriginatorTokens();
  });

  test("an accepted delivery records or refreshes its run's token", () => {
    recordMcpOriginatorDelivery({
      super_run_id: "sr-1",
      mcp_originator_token: "mst_one.secret-a",
    });
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-a");
    recordMcpOriginatorDelivery({
      super_run_id: "sr-1",
      mcp_originator_token: "mst_one.secret-c",
    });
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-c");
  });

  test("a tokenless redelivery clears stale authority for its run", () => {
    // The producer re-mints per delivery and revokes the prior token, so a
    // frame carrying the id but no token is authoritative: the run currently
    // has no listener-side authority, and an older token must not be reused.
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    recordMcpOriginatorDelivery({ super_run_id: "sr-1" });
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    // Other runs are untouched, and a tokenless id on an empty store is a
    // no-op.
    setMcpOriginatorToken("sr-2", "mst_two.secret-b");
    recordMcpOriginatorDelivery({ super_run_id: "sr-3" });
    expect(getMcpOriginatorToken("sr-2")).toBe("mst_two.secret-b");
    expect(mcpOriginatorTokenCount()).toBe(1);
  });

  test("a delivery without a super run id records nothing", () => {
    recordMcpOriginatorDelivery({ mcp_originator_token: "mst_one.secret-a" });
    recordMcpOriginatorDelivery({});
    expect(mcpOriginatorTokenCount()).toBe(0);
  });

  test("refresh-only deliveries update live entries but never create new ones", () => {
    // Duplicate re-acks and accepted approval/teleport payloads create no
    // new owning turn, so they may refresh a live run's re-minted token but
    // must not create an entry of their own (evil-shub r4300657683).
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    recordMcpOriginatorDelivery(
      { super_run_id: "sr-1", mcp_originator_token: "mst_one.secret-b" },
      { allowCreate: false },
    );
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-b");

    recordMcpOriginatorDelivery(
      { super_run_id: "sr-2", mcp_originator_token: "mst_two.secret-c" },
      { allowCreate: false },
    );
    expect(getMcpOriginatorToken("sr-2")).toBeUndefined();
    expect(mcpOriginatorTokenCount()).toBe(1);
  });

  test("a post-terminal duplicate cannot resurrect its run's retired token", () => {
    // The owning turn's finalizer retires the token at terminal state; a
    // duplicate re-ack arriving afterwards must not re-insert an orphaned
    // token no finalizer will ever clean up — and an origin-swap deletion
    // stays a stable boundary against late redeliveries.
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    deleteMcpOriginatorToken("sr-1"); // finalizer retirement
    recordMcpOriginatorDelivery(
      { super_run_id: "sr-1", mcp_originator_token: "mst_one.secret-b" },
      { allowCreate: false },
    );
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    expect(mcpOriginatorTokenCount()).toBe(0);
  });

  test("refresh-only still honors the tokenless clear for a live run", () => {
    // A duplicate of a tokenless frame is authoritative about the run now
    // having no listener-side authority, same as a fresh tokenless accept.
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    recordMcpOriginatorDelivery(
      { super_run_id: "sr-1" },
      { allowCreate: false },
    );
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
  });
});

describe("retireMcpOriginatorTokensOnOriginSwap", () => {
  afterEach(() => {
    clearMcpOriginatorTokens();
  });

  test("a cross-run approval swap retires both runs' tokens", () => {
    // The original turn (sr-1) consumed a queued input from sr-2: neither
    // run's authority may carry into the continuation (evil-shub r4300499685).
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    setMcpOriginatorToken("sr-2", "mst_two.secret-b");
    setMcpOriginatorToken("sr-unrelated", "mst_three.secret-c");
    retireMcpOriginatorTokensOnOriginSwap("sr-1", "sr-2");
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    expect(getMcpOriginatorToken("sr-2")).toBeUndefined();
    expect(getMcpOriginatorToken("sr-unrelated")).toBe("mst_three.secret-c");
  });

  test("a same-run follow-up keeps its held token", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    retireMcpOriginatorTokensOnOriginSwap("sr-1", "sr-1");
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_one.secret-a");
  });

  test("an unattributed queued input still drops the turn's token", () => {
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    retireMcpOriginatorTokensOnOriginSwap("sr-1", undefined);
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
  });

  test("an unattributed turn does not mint authority from the queued run", () => {
    setMcpOriginatorToken("sr-2", "mst_two.secret-b");
    retireMcpOriginatorTokensOnOriginSwap(undefined, "sr-2");
    expect(getMcpOriginatorToken("sr-2")).toBeUndefined();
  });
});
