import { afterEach, describe, expect, test } from "bun:test";
import {
  noteMcpOriginatorDelivery,
  resetMcpOriginatorAuthority,
} from "@/agent/mcp-originator-authority";
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
    resetMcpOriginatorAuthority();
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
    resetMcpOriginatorAuthority();
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
    resetMcpOriginatorAuthority();
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
    resetMcpOriginatorAuthority();
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

describe("MCP originator mint-generation ordering", () => {
  afterEach(() => {
    clearMcpOriginatorTokens();
    resetMcpOriginatorAuthority();
  });

  const frame = (superRunId: string, token?: string, generation?: number) => ({
    type: "input",
    super_run_id: superRunId,
    ...(token ? { mcp_originator_token: token } : {}),
    ...(generation !== undefined
      ? { mcp_originator_generation: generation }
      : {}),
  });

  test("a newer generation supersedes; an older zombie is dropped", () => {
    recordMcpOriginatorDelivery(frame("sr-1", "mst_a.secret", 3));
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_a.secret");
    recordMcpOriginatorDelivery(frame("sr-1", "mst_b.secret", 4));
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_b.secret");
    // Zombie from a superseded delivery attempt: dropped.
    recordMcpOriginatorDelivery(frame("sr-1", "mst_zombie.secret", 2));
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_b.secret");
  });

  test("an equal generation is an idempotent re-delivery (last write wins)", () => {
    recordMcpOriginatorDelivery(frame("sr-1", "mst_a.secret", 3));
    recordMcpOriginatorDelivery(frame("sr-1", "mst_b.secret", 3));
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_b.secret");
  });

  test("a generated entry rejects legacy (generation-less) deliveries", () => {
    recordMcpOriginatorDelivery(frame("sr-1", "mst_a.secret", 3));
    recordMcpOriginatorDelivery(frame("sr-1", "mst_legacy.secret"));
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_a.secret");
  });

  test("a legacy entry accepts any delivery, including generated upgrades", () => {
    recordMcpOriginatorDelivery(frame("sr-1", "mst_legacy.secret"));
    recordMcpOriginatorDelivery(frame("sr-1", "mst_older.secret", 1));
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_older.secret");
    recordMcpOriginatorDelivery(frame("sr-1", "mst_newer.secret", 2));
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_newer.secret");
    // ...and once upgraded, legacy deliveries are rejected.
    recordMcpOriginatorDelivery(frame("sr-1", "mst_legacy2.secret"));
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_newer.secret");
  });

  test("a stale tokenless frame cannot clear a generated entry", () => {
    recordMcpOriginatorDelivery(frame("sr-1", "mst_a.secret", 5));
    // Legacy tokenless clear: rejected.
    recordMcpOriginatorDelivery(frame("sr-1"));
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_a.secret");
    // Older-generated clear: rejected.
    recordMcpOriginatorDelivery(frame("sr-1", undefined, 4));
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_a.secret");
    // Same-generation tokenless frame clears into a tombstone.
    recordMcpOriginatorDelivery(frame("sr-1", undefined, 5));
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    expect(mcpOriginatorTokenCount()).toBe(0);
  });

  test("a tombstone blocks a stale re-create below its generation", () => {
    recordMcpOriginatorDelivery(frame("sr-1", "mst_a.secret", 5));
    recordMcpOriginatorDelivery(frame("sr-1", undefined, 6));
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    // Stale create below the tombstone generation: dropped.
    recordMcpOriginatorDelivery(frame("sr-1", "mst_zombie.secret", 5));
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    // Newer create revives (last-write-wins across the tombstone).
    recordMcpOriginatorDelivery(frame("sr-1", "mst_live.secret", 7));
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_live.secret");
  });

  test("a malformed generation degrades to legacy", () => {
    recordMcpOriginatorDelivery(frame("sr-1", "mst_a.secret", 3));
    recordMcpOriginatorDelivery({
      type: "input",
      super_run_id: "sr-1",
      mcp_originator_token: "mst_bad.secret",
      mcp_originator_generation: Number.NaN,
    });
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_a.secret");
    recordMcpOriginatorDelivery({
      type: "input",
      super_run_id: "sr-1",
      mcp_originator_token: "mst_bad2.secret",
      mcp_originator_generation: -1,
    });
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_a.secret");
    recordMcpOriginatorDelivery({
      type: "input",
      super_run_id: "sr-1",
      mcp_originator_token: "mst_bad3.secret",
      mcp_originator_generation: 2.5,
    });
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_a.secret");
  });

  test("refresh-only deliveries need a live durable owner to recreate", () => {
    recordMcpOriginatorDelivery(frame("sr-1", "mst_a.secret", 3));
    deleteMcpOriginatorToken("sr-1");
    // No predicate: refresh cannot create.
    recordMcpOriginatorDelivery(frame("sr-1", "mst_b.secret", 4), {
      allowCreate: false,
    });
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    // Predicate proving a terminal tombstone (false): still cannot create.
    recordMcpOriginatorDelivery(frame("sr-1", "mst_b.secret", 4), {
      allowCreate: false,
      mayRecreateOwner: () => false,
    });
    expect(getMcpOriginatorToken("sr-1")).toBeUndefined();
    // Predicate proving a live owner (crash recovery): recreate allowed.
    recordMcpOriginatorDelivery(frame("sr-1", "mst_b.secret", 4), {
      allowCreate: false,
      mayRecreateOwner: () => true,
    });
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_b.secret");
    // Refresh of an EXISTING entry needs no predicate but keeps ordering.
    recordMcpOriginatorDelivery(frame("sr-1", "mst_zombie.secret", 2), {
      allowCreate: false,
    });
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_b.secret");
    recordMcpOriginatorDelivery(frame("sr-1", "mst_c.secret", 5), {
      allowCreate: false,
    });
    expect(getMcpOriginatorToken("sr-1")).toBe("mst_c.secret");
  });
});

describe("round-8 verdict split + sanitized denial logging (evil-shub round-8 P1)", () => {
  afterEach(() => {
    clearMcpOriginatorTokens();
    resetMcpOriginatorAuthority();
  });

  test("a malformed generation denies PERMANENTLY and the log never contains the raw wire value", () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    };
    try {
      // A bearer-shaped string in the generation field: untrusted wire
      // content that must never be echoed into logs.
      const verdict = recordMcpOriginatorDelivery({
        mcp_originator_token: "mst_r8tok_malformed",
        super_run_id: "run-r8tok-malformed",
        mcp_originator_generation:
          "mst_SECRET_TOKEN_VALUE" as unknown as number,
      });
      expect(verdict).toBe("denied_permanent");
      expect(getMcpOriginatorToken("run-r8tok-malformed")).toBeUndefined();
      expect(errors.length).toBeGreaterThan(0);
      for (const line of errors) {
        expect(line).not.toContain("mst_SECRET_TOKEN_VALUE");
      }
    } finally {
      console.error = originalError;
    }
  });

  test("a stale generation at-or-below the durable floor denies PERMANENTLY", () => {
    noteMcpOriginatorDelivery("run-r8tok-stale", 5);
    expect(
      recordMcpOriginatorDelivery({
        mcp_originator_token: "mst_r8tok_stale",
        super_run_id: "run-r8tok-stale",
        mcp_originator_generation: 4,
      }),
    ).toBe("denied_permanent");
    expect(getMcpOriginatorToken("run-r8tok-stale")).toBeUndefined();
  });
});
