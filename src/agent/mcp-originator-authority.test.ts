import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureMcpOriginatorAuthorityPersistenceForTests,
  markMcpOriginatorTerminal,
  mcpOriginatorAuthorityAllows,
  noteMcpOriginatorDelivery,
  readMcpOriginatorAuthorityForTests,
  resetMcpOriginatorAuthority,
} from "./mcp-originator-authority";
import {
  clearMcpOriginatorTokens,
  getMcpOriginatorToken,
  recordMcpOriginatorDelivery,
  retireMcpOriginatorTokenOnMixedMerge,
  retireMcpOriginatorTokenOnTerminal,
  retireMcpOriginatorTokensOnOriginSwap,
  setMcpOriginatorToken,
} from "./mcp-originator-tokens";

afterEach(() => {
  clearMcpOriginatorTokens();
  resetMcpOriginatorAuthority();
  configureMcpOriginatorAuthorityPersistenceForTests(null);
});

describe("generation floor", () => {
  test("a zombie below the durable floor is rejected on an empty store", () => {
    noteMcpOriginatorDelivery("run-a", 2);
    expect(mcpOriginatorAuthorityAllows("run-a", 1)).toBe(false);
    expect(mcpOriginatorAuthorityAllows("run-a", 2)).toBe(true);
    expect(mcpOriginatorAuthorityAllows("run-a", 3)).toBe(true);
  });

  test("a legacy (generation-less) delivery is rejected beneath a floor", () => {
    noteMcpOriginatorDelivery("run-a", 1);
    expect(mcpOriginatorAuthorityAllows("run-a", undefined)).toBe(false);
  });

  test("a legacy delivery is allowed when no record exists", () => {
    expect(mcpOriginatorAuthorityAllows("run-a", undefined)).toBe(true);
  });

  test("a zombie create is dropped by the store even with an empty Map", () => {
    recordMcpOriginatorDelivery({
      super_run_id: "run-a",
      mcp_originator_token: "mst_b",
      mcp_originator_generation: 2,
    });
    expect(getMcpOriginatorToken("run-a")).toBe("mst_b");
    clearMcpOriginatorTokens(); // simulate process crash: volatile Map lost
    recordMcpOriginatorDelivery({
      super_run_id: "run-a",
      mcp_originator_token: "mst_a",
      mcp_originator_generation: 1,
    });
    expect(getMcpOriginatorToken("run-a")).toBeUndefined();
  });

  test("a tokenless frame on an empty store still bumps the floor", () => {
    recordMcpOriginatorDelivery({
      super_run_id: "run-a",
      mcp_originator_generation: 5,
    });
    recordMcpOriginatorDelivery({
      super_run_id: "run-a",
      mcp_originator_token: "mst_zombie",
      mcp_originator_generation: 3,
    });
    expect(getMcpOriginatorToken("run-a")).toBeUndefined();
  });
});

describe("authority state monotonicity", () => {
  test("headerless blocks every later delivery, even a newer generation", () => {
    setMcpOriginatorToken("run-a", "mst_a");
    retireMcpOriginatorTokenOnMixedMerge("run-a");
    expect(getMcpOriginatorToken("run-a")).toBeUndefined();
    recordMcpOriginatorDelivery({
      super_run_id: "run-a",
      mcp_originator_token: "mst_newer",
      mcp_originator_generation: 9,
    });
    expect(getMcpOriginatorToken("run-a")).toBeUndefined();
    expect(readMcpOriginatorAuthorityForTests("run-a")?.state).toBe(
      "headerless",
    );
  });

  test("terminal blocks every later delivery", () => {
    setMcpOriginatorToken("run-a", "mst_a");
    retireMcpOriginatorTokenOnTerminal("run-a");
    recordMcpOriginatorDelivery({
      super_run_id: "run-a",
      mcp_originator_token: "mst_newer",
      mcp_originator_generation: 4,
    });
    expect(getMcpOriginatorToken("run-a")).toBeUndefined();
    expect(readMcpOriginatorAuthorityForTests("run-a")?.state).toBe("terminal");
  });

  test("an origin swap headerlesses both runs and blocks duplicate recreate with a live-owner proof", () => {
    recordMcpOriginatorDelivery({
      super_run_id: "run-a",
      mcp_originator_token: "mst_a",
      mcp_originator_generation: 1,
    });
    recordMcpOriginatorDelivery({
      super_run_id: "run-b",
      mcp_originator_token: "mst_b",
      mcp_originator_generation: 1,
    });
    retireMcpOriginatorTokensOnOriginSwap("run-a", "run-b");
    for (const runId of ["run-a", "run-b"]) {
      expect(getMcpOriginatorToken(runId)).toBeUndefined();
      // The durable-live-owner escape hatch must NOT reopen a swap boundary.
      recordMcpOriginatorDelivery(
        {
          super_run_id: runId,
          mcp_originator_token: "mst_rearmed",
          mcp_originator_generation: 2,
        },
        { allowCreate: false, mayRecreateOwner: () => true },
      );
      expect(getMcpOriginatorToken(runId)).toBeUndefined();
    }
  });

  test("a same-run origin swap is a no-op and keeps authority", () => {
    recordMcpOriginatorDelivery({
      super_run_id: "run-a",
      mcp_originator_token: "mst_a",
      mcp_originator_generation: 1,
    });
    retireMcpOriginatorTokensOnOriginSwap("run-a", "run-a");
    expect(getMcpOriginatorToken("run-a")).toBe("mst_a");
    expect(readMcpOriginatorAuthorityForTests("run-a")?.state).toBe("live");
  });

  test("crash recovery still works: a live run at the floor recreates with proof", () => {
    recordMcpOriginatorDelivery({
      super_run_id: "run-a",
      mcp_originator_token: "mst_a",
      mcp_originator_generation: 2,
    });
    clearMcpOriginatorTokens(); // crash
    recordMcpOriginatorDelivery(
      {
        super_run_id: "run-a",
        mcp_originator_token: "mst_a2",
        mcp_originator_generation: 2,
      },
      { allowCreate: false, mayRecreateOwner: () => true },
    );
    expect(getMcpOriginatorToken("run-a")).toBe("mst_a2");
  });
});

describe("durability", () => {
  test("records survive an in-memory reset via the persistence path", () => {
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-"));
    try {
      const path = join(root, "authority.json");
      configureMcpOriginatorAuthorityPersistenceForTests(path);
      noteMcpOriginatorDelivery("run-a", 7);
      markMcpOriginatorTerminal("run-b", 3);
      resetMcpOriginatorAuthority();
      expect(mcpOriginatorAuthorityAllows("run-a", 6)).toBe(false);
      expect(mcpOriginatorAuthorityAllows("run-a", 7)).toBe(true);
      expect(readMcpOriginatorAuthorityForTests("run-b")?.state).toBe(
        "terminal",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("records older than the TTL are pruned (tokens are long dead)", () => {
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-"));
    try {
      const path = join(root, "authority.json");
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          records: {
            "run-old": {
              floor: 9,
              state: "terminal",
              updatedAtMs: Date.now() - 3 * 60 * 60 * 1000,
            },
          },
        }),
        { mode: 0o600 },
      );
      configureMcpOriginatorAuthorityPersistenceForTests(path);
      resetMcpOriginatorAuthority();
      expect(mcpOriginatorAuthorityAllows("run-old", undefined)).toBe(true);
      expect(readMcpOriginatorAuthorityForTests("run-old")).toBeUndefined();
      // A pruned file is rewritten without the stale record on next touch.
      noteMcpOriginatorDelivery("run-new", 1);
      const file = JSON.parse(readFileSync(path, "utf8")) as {
        records: Record<string, unknown>;
      };
      expect(file.records["run-old"]).toBeUndefined();
      expect(file.records["run-new"]).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cross-process durability (evil-shub round 4)", () => {
  test("a denied recreation still advances the durable floor, blocking later zombies", () => {
    // B/gen2 duplicate arrives with no volatile entry and a transiently
    // failing live-owner proof: recreation is denied, but the delivery is
    // still accepted/ACKed upstream, so the floor MUST advance to gen2 —
    // otherwise a later A/gen1 zombie slips beneath it and recreates the
    // revoked entry.
    recordMcpOriginatorDelivery(
      {
        mcp_originator_token: "token-b",
        super_run_id: "run-x",
        mcp_originator_generation: 2,
      },
      { allowCreate: false, mayRecreateOwner: () => false },
    );
    expect(getMcpOriginatorToken("run-x")).toBeUndefined();
    expect(readMcpOriginatorAuthorityForTests("run-x")?.floor).toBe(2);
    // The gen1 zombie is now rejected by the floor even with a live-owner
    // proof available again.
    recordMcpOriginatorDelivery(
      {
        mcp_originator_token: "token-a",
        super_run_id: "run-x",
        mcp_originator_generation: 1,
      },
      { allowCreate: false, mayRecreateOwner: () => true },
    );
    expect(getMcpOriginatorToken("run-x")).toBeUndefined();
  });

  test("another process's durable record is merged, never clobbered", () => {
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-"));
    try {
      const path = join(root, "authority.json");
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          records: {
            "run-foreign": {
              floor: 7,
              state: "terminal",
              updatedAtMs: Date.now(),
            },
          },
        }),
        { mode: 0o600 },
      );
      configureMcpOriginatorAuthorityPersistenceForTests(path);
      resetMcpOriginatorAuthority();
      // A local write must read-merge: the foreign terminal record survives.
      noteMcpOriginatorDelivery("run-local", 1);
      const file = JSON.parse(readFileSync(path, "utf8")) as {
        records: Record<string, { state: string }>;
      };
      expect(file.records["run-foreign"]?.state).toBe("terminal");
      expect(file.records["run-local"]).toBeDefined();
      expect(mcpOriginatorAuthorityAllows("run-foreign", 99)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an in-memory mark survives a failed durable write and keeps gating", () => {
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-"));
    try {
      // Point persistence AT A DIRECTORY so every write fails.
      configureMcpOriginatorAuthorityPersistenceForTests(root);
      resetMcpOriginatorAuthority();
      recordMcpOriginatorDelivery(
        {
          mcp_originator_token: "token-y",
          super_run_id: "run-y",
          mcp_originator_generation: 3,
        },
        { allowCreate: true },
      );
      retireMcpOriginatorTokenOnTerminal("run-y");
      // Volatile token is gone (fail-closed) and the terminal boundary still
      // gates from the in-memory overlay even though nothing persisted.
      expect(getMcpOriginatorToken("run-y")).toBeUndefined();
      expect(mcpOriginatorAuthorityAllows("run-y", 4)).toBe(false);
      recordMcpOriginatorDelivery(
        {
          mcp_originator_token: "token-y2",
          super_run_id: "run-y",
          mcp_originator_generation: 4,
        },
        { allowCreate: false, mayRecreateOwner: () => true },
      );
      expect(getMcpOriginatorToken("run-y")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed durable write self-heals on the next successful transaction", () => {
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-"));
    try {
      const broken = join(root, "blocked");
      // 'blocked' is a directory: writes fail while it exists.
      mkdirSync(broken);
      configureMcpOriginatorAuthorityPersistenceForTests(broken);
      resetMcpOriginatorAuthority();
      markMcpOriginatorTerminal("run-z");
      // Unbreak persistence: the overlay must flow to disk on the next write.
      const healed = join(root, "authority.json");
      configureMcpOriginatorAuthorityPersistenceForTests(healed);
      noteMcpOriginatorDelivery("run-z", 1);
      const file = JSON.parse(readFileSync(healed, "utf8")) as {
        records: Record<string, { state: string }>;
      };
      expect(file.records["run-z"]?.state).toBe("terminal");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
