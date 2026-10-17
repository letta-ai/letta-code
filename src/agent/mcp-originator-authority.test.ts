import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitMcpOriginatorDelivery,
  configureMcpOriginatorAuthorityPersistenceForTests,
  configureMcpOriginatorAuthorityTtlForTests,
  markMcpOriginatorHeaderless,
  markMcpOriginatorTerminal,
  mcpOriginatorAuthorityAllows,
  mcpOriginatorAuthorityPermitsUse,
  noteMcpOriginatorDelivery,
  readMcpOriginatorAuthorityForTests,
  readPendingMcpOriginatorRetirementsForTests,
  resetMcpOriginatorAuthority,
  retryPendingMcpOriginatorRetirements,
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

describe("degraded durable file fail-closed (evil-shub round 5 P1)", () => {
  function withDegradedFile(run: (path: string) => void) {
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-"));
    try {
      const path = join(root, "authority.json");
      writeFileSync(path, "{ not json !!!");
      configureMcpOriginatorAuthorityPersistenceForTests(path);
      resetMcpOriginatorAuthority();
      run(path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("admission, use, and the gate all deny when the durable file is unreadable", () => {
    withDegradedFile(() => {
      expect(mcpOriginatorAuthorityAllows("run-a", 1)).toBe(false);
      expect(admitMcpOriginatorDelivery("run-a", 1)).toEqual({
        admitted: false,
        permanent: false,
      });
      expect(mcpOriginatorAuthorityPermitsUse("run-a", 1)).toBe(false);
      expect(readMcpOriginatorAuthorityForTests("run-a")).toBeUndefined();
    });
  });

  test("a terminal mark applies in-process but never clobbers the unreadable file", () => {
    withDegradedFile((path) => {
      expect(markMcpOriginatorTerminal("run-a")).toBe(false);
      // The in-process fail-closed boundary stands for this process.
      expect(mcpOriginatorAuthorityAllows("run-a", 99)).toBe(false);
      // The damaged file is untouched, so a later restart fails closed again.
      expect(readFileSync(path, "utf8")).toBe("{ not json !!!");
    });
  });

  test("the store drops a delivery the degraded authority cannot admit", () => {
    withDegradedFile(() => {
      recordMcpOriginatorDelivery({
        mcp_originator_token: "mst_a",
        super_run_id: "run-a",
        mcp_originator_generation: 1,
      });
      expect(getMcpOriginatorToken("run-a")).toBeUndefined();
    });
  });

  test("getMcpOriginatorToken fails closed on a degraded authority", () => {
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-"));
    try {
      const path = join(root, "authority.json");
      writeFileSync(path, "{ not json !!!");
      configureMcpOriginatorAuthorityPersistenceForTests(path);
      resetMcpOriginatorAuthority();
      setMcpOriginatorToken("run-a", "mst_a");
      expect(getMcpOriginatorToken("run-a")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovering the file restores fail-open admission", () => {
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-"));
    try {
      const path = join(root, "authority.json");
      writeFileSync(path, "{ not json !!!");
      configureMcpOriginatorAuthorityPersistenceForTests(path);
      resetMcpOriginatorAuthority();
      expect(admitMcpOriginatorDelivery("run-a", 1)).toEqual({
        admitted: false,
        permanent: false,
      });
      // Operator restores a valid file: the next read heals.
      writeFileSync(path, JSON.stringify({ version: 1, records: {} }));
      expect(admitMcpOriginatorDelivery("run-a", 1)).toEqual({
        admitted: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("atomic admit and use-time recheck (evil-shub round 5 P2)", () => {
  test("admit bumps the durable floor in one shot, then rejects zombies", () => {
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-"));
    try {
      const path = join(root, "authority.json");
      configureMcpOriginatorAuthorityPersistenceForTests(path);
      resetMcpOriginatorAuthority();
      expect(admitMcpOriginatorDelivery("run-a", 5)).toEqual({
        admitted: true,
      });
      const disk = JSON.parse(readFileSync(path, "utf8")) as {
        records: Record<string, { floor?: number }>;
      };
      expect(disk.records["run-a"]?.floor).toBe(5);
      expect(admitMcpOriginatorDelivery("run-a", 4)).toEqual({
        admitted: false,
        permanent: true,
      });
      expect(admitMcpOriginatorDelivery("run-a", 5)).toEqual({
        admitted: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a terminal state cannot be re-admitted", () => {
    markMcpOriginatorTerminal("run-a");
    expect(admitMcpOriginatorDelivery("run-a", 6)).toEqual({
      admitted: false,
      permanent: true,
    });
  });

  test("permitsUse tracks floor and state", () => {
    noteMcpOriginatorDelivery("run-a", 5);
    expect(mcpOriginatorAuthorityPermitsUse("run-a", 5)).toBe(true);
    expect(mcpOriginatorAuthorityPermitsUse("run-a", 4)).toBe(false);
    markMcpOriginatorTerminal("run-a");
    expect(mcpOriginatorAuthorityPermitsUse("run-a", 5)).toBe(false);
  });

  test("getMcpOriginatorToken withdraws when the durable floor passed its generation", () => {
    recordMcpOriginatorDelivery({
      mcp_originator_token: "mst_a",
      super_run_id: "run-a",
      mcp_originator_generation: 1,
    });
    expect(getMcpOriginatorToken("run-a")).toBe("mst_a");
    // Another listener instance admits gen2 durably; this process merges it.
    noteMcpOriginatorDelivery("run-a", 2);
    expect(getMcpOriginatorToken("run-a")).toBeUndefined();
  });

  test("malformed wire generations are denied fail-closed (round-7; evil-shub round-6 P1)", () => {
    for (const bad of [1.5, -1, Number.NaN, "2" as unknown as number]) {
      expect(admitMcpOriginatorDelivery("run-bad", bad)).toEqual({
        admitted: false,
        permanent: true,
      });
      expect(
        recordMcpOriginatorDelivery({
          mcp_originator_token: "mst_bad",
          super_run_id: "run-bad",
          mcp_originator_generation: bad,
        }),
      ).toBe("denied_permanent");
    }
    // No poisoned floor, no entry, and a well-formed delivery still admits.
    expect(readMcpOriginatorAuthorityForTests("run-bad")).toBeUndefined();
    expect(getMcpOriginatorToken("run-bad")).toBeUndefined();
    expect(admitMcpOriginatorDelivery("run-bad", 2)).toEqual({
      admitted: true,
    });
    expect(readMcpOriginatorAuthorityForTests("run-bad")?.floor).toBe(2);
  });

  test("a malformed generation cannot poison the floor through note/touch", () => {
    noteMcpOriginatorDelivery("run-c", Number.NaN);
    expect(readMcpOriginatorAuthorityForTests("run-c")?.floor).toBeUndefined();
    noteMcpOriginatorDelivery("run-c", 3);
    expect(readMcpOriginatorAuthorityForTests("run-c")?.floor).toBe(3);
    expect(mcpOriginatorAuthorityPermitsUse("run-c", Number.NaN)).toBe(false);
    expect(mcpOriginatorAuthorityPermitsUse("run-c", 3)).toBe(true);
  });

  test("a structurally invalid floor on disk degrades the file fail-closed", () => {
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-"));
    try {
      const path = join(root, "authority.json");
      for (const badFloor of ["3", 1.5, -2]) {
        writeFileSync(
          path,
          JSON.stringify({
            version: 1,
            records: {
              "run-d": {
                floor: badFloor,
                state: "live",
                updatedAtMs: Date.now(),
              },
            },
          }),
        );
        configureMcpOriginatorAuthorityPersistenceForTests(path);
        resetMcpOriginatorAuthority();
        // Degraded durable state denies admission and use (fail-closed) and
        // must NOT be clobbered by a fresh write.
        expect(admitMcpOriginatorDelivery("run-d", 4)).toEqual({
          admitted: false,
          permanent: false,
        });
        expect(mcpOriginatorAuthorityPermitsUse("run-d", 4)).toBe(false);
        expect(readFileSync(path, "utf8")).toContain('"live"');
        configureMcpOriginatorAuthorityPersistenceForTests(null);
        resetMcpOriginatorAuthority();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("strict durable file validation (evil-shub round-8 P1)", () => {
  test("an array-shaped records field degrades the WHOLE file instead of reading as empty", () => {
    // `typeof [] === "object"` passed the round-7 check, so a corrupt file
    // with an array payload read as a HEALTHY EMPTY file — silently
    // dropping every persisted boundary (fail-open).
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-"));
    try {
      const path = join(root, "authority.json");
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          records: [["run-a", { state: "terminal", updatedAtMs: 1 }]],
        }),
      );
      configureMcpOriginatorAuthorityPersistenceForTests(path);
      resetMcpOriginatorAuthority();
      expect(admitMcpOriginatorDelivery("run-a", 1)).toEqual({
        admitted: false,
        permanent: false,
      });
      expect(mcpOriginatorAuthorityPermitsUse("run-a", 1)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("negative, fractional, and far-future updatedAtMs values degrade the WHOLE file", () => {
    // updatedAtMs drives TTL pruning: a negative value makes every record
    // look expired (the prune erases a terminal boundary → fail-open), and
    // a far-future one pins a stale floor against pruning forever. Neither
    // may be reinterpreted; the file is untrustworthy.
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-"));
    try {
      const path = join(root, "authority.json");
      configureMcpOriginatorAuthorityPersistenceForTests(path);
      for (const bad of [
        -1,
        1.5,
        Date.now() + 48 * 60 * 60 * 1000,
        Number.NaN,
      ]) {
        writeFileSync(
          path,
          JSON.stringify({
            version: 1,
            records: { "run-a": { state: "live", updatedAtMs: bad } },
          }),
        );
        resetMcpOriginatorAuthority();
        expect(admitMcpOriginatorDelivery("run-a", 1)).toEqual({
          admitted: false,
          permanent: false,
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("state monotonicity across out-of-order retirement marks (round-8)", () => {
  test("a headerless mark landing after a terminal mark keeps the terminal state", () => {
    markMcpOriginatorTerminal("run-r8mono");
    markMcpOriginatorHeaderless("run-r8mono");
    expect(readMcpOriginatorAuthorityForTests("run-r8mono")?.state).toBe(
      "terminal",
    );
    expect(admitMcpOriginatorDelivery("run-r8mono", 1)).toEqual({
      admitted: false,
      permanent: true,
    });
  });
});

describe("durable retirement retry (evil-shub round-8 P1)", () => {
  test("a failed retirement is retried until it lands, and the boundary survives a reload", () => {
    // The exact trap sequence: healthy admission persists a live record →
    // persistence breaks (path becomes a directory: EISDIR on read, and the
    // clobber guard blocks the write) → the retirement returns false but
    // the in-memory overlay already denies → persistence heals → the
    // registered retry lands the mark durably → a reload preserves it.
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-"));
    try {
      const path = join(root, "authority.json");
      configureMcpOriginatorAuthorityPersistenceForTests(path);
      resetMcpOriginatorAuthority();

      expect(admitMcpOriginatorDelivery("run-a", 1)).toEqual({
        admitted: true,
      });

      // Break persistence: the configured path is now a DIRECTORY.
      rmSync(path);
      mkdirSync(path);
      expect(markMcpOriginatorHeaderless("run-a", 1)).toBe(false);
      // The in-memory overlay denies use immediately…
      expect(mcpOriginatorAuthorityPermitsUse("run-a", 1)).toBe(false);
      // …and the retirement is registered for retry.
      expect(
        readPendingMcpOriginatorRetirementsForTests().get("run-a")?.state,
      ).toBe("headerless");

      // Heal persistence and drive the retry: the mark lands durably.
      rmdirSync(path);
      retryPendingMcpOriginatorRetirements();
      expect(readPendingMcpOriginatorRetirementsForTests().size).toBe(0);
      const disk = JSON.parse(readFileSync(path, "utf8")) as {
        records: Record<string, { state: string; floor?: number }>;
      };
      expect(disk.records["run-a"]?.state).toBe("headerless");
      expect(disk.records["run-a"]?.floor).toBe(1);

      // A reload (process restart) preserves the boundary fail-closed.
      resetMcpOriginatorAuthority();
      expect(admitMcpOriginatorDelivery("run-a", 2)).toEqual({
        admitted: false,
        permanent: true,
      });
      expect(mcpOriginatorAuthorityPermitsUse("run-a", 1)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("durable retirement intent (evil-shub round-9 P1)", () => {
  test("a failed mark persists the retiringTo intent; peers deny admission and use for the intent-carrying record", () => {
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-intent-"));
    try {
      const path = join(root, "authority.json");
      configureMcpOriginatorAuthorityPersistenceForTests(path);
      resetMcpOriginatorAuthority();

      expect(admitMcpOriginatorDelivery("run-a", 1)).toEqual({
        admitted: true,
      });

      // Break persistence, then retire: the mark fails, but the INTENT
      // write is attempted first. While persistence is broken neither
      // lands; heal JUST enough for the intent write by re-registering.
      rmSync(path);
      mkdirSync(path);
      expect(markMcpOriginatorHeaderless("run-a", 1)).toBe(false);
      expect(
        readPendingMcpOriginatorRetirementsForTests().get("run-a")?.state,
      ).toBe("headerless");

      // Heal: the pending retry lands the mark — but first prove the
      // intent path itself: re-break after healing so only the intent
      // (not the mark) is durable, simulating a process that died between
      // intent and mark. Do it directly: write an intent-only record.
      rmdirSync(path);
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          records: {
            "run-b": {
              state: "live",
              retiringTo: "headerless",
              floor: 3,
              updatedAtMs: Date.now(),
            },
          },
        }),
      );

      // A peer process (fresh overlay) reading the file treats the
      // intent-carrying record as NOT live: admission and use both deny
      // permanently, even though the durable state is still "live".
      resetMcpOriginatorAuthority();
      expect(admitMcpOriginatorDelivery("run-b", 4)).toEqual({
        admitted: false,
        permanent: true,
      });
      expect(mcpOriginatorAuthorityPermitsUse("run-b", 3)).toBe(false);
      expect(mcpOriginatorAuthorityAllows("run-b", 5)).toBe(false);
      expect(readMcpOriginatorAuthorityForTests("run-b")).toMatchObject({
        state: "live",
        retiringTo: "headerless",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a restart resumes a durable retirement intent and the retry lands the mark", () => {
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-resume-"));
    try {
      const path = join(root, "authority.json");
      // The dead process left ONLY the intent behind (mark never landed).
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          records: {
            "run-a": {
              state: "live",
              retiringTo: "terminal",
              floor: 2,
              updatedAtMs: Date.now(),
            },
          },
        }),
      );
      configureMcpOriginatorAuthorityPersistenceForTests(path);
      resetMcpOriginatorAuthority();

      // Any transaction reloads the file and re-registers the retry.
      expect(mcpOriginatorAuthorityPermitsUse("run-a", 2)).toBe(false);
      expect(
        readPendingMcpOriginatorRetirementsForTests().get("run-a")?.state,
      ).toBe("terminal");

      retryPendingMcpOriginatorRetirements();
      expect(readPendingMcpOriginatorRetirementsForTests().size).toBe(0);
      const disk = JSON.parse(readFileSync(path, "utf8")) as {
        records: Record<
          string,
          { state: string; retiringTo?: string; floor?: number }
        >;
      };
      // The mark landed and the intent is cleared (the landed state is the
      // stronger boundary).
      expect(disk.records["run-a"]?.state).toBe("terminal");
      expect(disk.records["run-a"]?.retiringTo).toBeUndefined();
      expect(disk.records["run-a"]?.floor).toBe(2);

      // And the boundary survives another reload.
      resetMcpOriginatorAuthority();
      expect(admitMcpOriginatorDelivery("run-a", 3)).toEqual({
        admitted: false,
        permanent: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pending retirement older than the record TTL is dropped loudly instead of retried forever", () => {
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-ttl-"));
    try {
      const path = join(root, "authority.json");
      configureMcpOriginatorAuthorityPersistenceForTests(path);
      resetMcpOriginatorAuthority();
      // Set AFTER the reset: the reset restores the default TTL.
      configureMcpOriginatorAuthorityTtlForTests(1);

      expect(admitMcpOriginatorDelivery("run-a", 1)).toEqual({
        admitted: true,
      });
      // Break persistence so the retirement stays pending.
      rmSync(path);
      mkdirSync(path);
      expect(markMcpOriginatorHeaderless("run-a", 1)).toBe(false);
      expect(readPendingMcpOriginatorRetirementsForTests().size).toBe(1);

      // Let the entry outlive the (test-shortened) TTL; the retry drops it
      // rather than storming the dead store every 30s forever.
      const deadline = Date.now() + 50;
      while (Date.now() < deadline) {
        // busy-wait a few ms past the 1ms TTL
      }
      retryPendingMcpOriginatorRetirements();
      expect(readPendingMcpOriginatorRetirementsForTests().size).toBe(0);
    } finally {
      configureMcpOriginatorAuthorityTtlForTests(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an invalid retiringTo value degrades the WHOLE file (fail-closed, retryable)", () => {
    const root = mkdtempSync(join(tmpdir(), "letta-mcp-authority-intent-bad-"));
    try {
      const path = join(root, "authority.json");
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          records: {
            "run-a": {
              state: "live",
              retiringTo: "bogus",
              updatedAtMs: Date.now(),
            },
          },
        }),
      );
      configureMcpOriginatorAuthorityPersistenceForTests(path);
      resetMcpOriginatorAuthority();
      expect(admitMcpOriginatorDelivery("run-a", 1)).toEqual({
        admitted: false,
        permanent: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
