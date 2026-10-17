/**
 * Durable MCP originator authority records (USER_SCOPED_MCP_CONNECTIONS).
 *
 * The in-memory token Map in mcp-originator-tokens.ts forgets everything on
 * teardown, which leaves three paired holes (evil-shub round-3 review):
 *
 * - No generation floor: a zombie delivery from a superseded mint attempt is
 *   accepted whenever the newer generation is not (or no longer) visible in
 *   memory — before the newer frame arrives, or after a restart forgot it.
 * - Liveness is not authority: the durable input ledger can prove a run's
 *   input is still live, but not that the run still OWNS MCP authority. An
 *   approval origin swap or a mixed-batch merge deliberately deletes the
 *   run's token so the continuation stays headerless; a duplicate frame
 *   would otherwise recreate the key and re-arm the header mid-turn.
 * - Terminal runs must stay retired: a post-terminal duplicate must never
 *   re-insert a token.
 *
 * This module keeps a small durable record per super run id:
 *
 *   { floor?: number; state: "live" | "headerless" | "terminal"; updatedAtMs }
 *
 * floor is the maximum observed mint generation; state transitions only ever
 * move live → headerless|terminal (never back), mirroring the fail-closed
 * intent of the boundaries that set them. Records survive process restarts
 * in the same ~/.letta/state/<server-namespace>/ directory as the accepted
 * input disposition ledger.
 *
 * Bounded by design: originator tokens carry a 1-hour absolute TTL ceiling
 * server-side, so any record older than AUTHORITY_RECORD_TTL_MS (2h, twice
 * the ceiling) can only describe dead tokens and is pruned on access.
 *
 * Persistence is serialized read-modify-write under the shared interprocess
 * durable-file lock: every transaction re-reads and merges the file, so
 * concurrent listener processes sharing the server-scoped file cannot erase
 * each other's records (whole-file last-writer-wins would). Mutations are
 * durable-first — callers retire volatile token state only after the mark
 * lands. A failed write still applies the boundary in-memory (fail-closed
 * for the live process) and logs every failure, never throwing into the
 * input path.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getServerUrl } from "@/backend/api/server-url";
import {
  acquireDurableFileLock,
  fsyncDirectory,
} from "@/websocket/listener/durable-file-lock";

export type McpOriginatorAuthorityState = "live" | "headerless" | "terminal";

type AuthorityRecord = {
  /** Highest mint generation observed for this run (any delivery kind). */
  floor?: number;
  state: McpOriginatorAuthorityState;
  updatedAtMs: number;
};

type AuthorityFile = {
  version: 1;
  records: Record<string, AuthorityRecord>;
};

/** Twice the server-side 1h absolute token ceiling. */
const AUTHORITY_RECORD_TTL_MS = 2 * 60 * 60 * 1000;

const recordsBySuperRunId = new Map<string, AuthorityRecord>();

let persistencePathOverride: string | null | undefined;

function authorityPersistentPath(): string | null {
  if (persistencePathOverride !== undefined) return persistencePathOverride;
  if (process.env.NODE_ENV === "test") return null;
  let serverUrl: string;
  try {
    serverUrl = getServerUrl();
  } catch {
    serverUrl = process.env.LETTA_BASE_URL ?? "uninitialized";
  }
  const namespace = createHash("sha256")
    .update(serverUrl)
    .digest("hex")
    .slice(0, 24);
  return join(
    homedir(),
    ".letta",
    "state",
    namespace,
    "mcp-originator-authority-v1.json",
  );
}

function pruneExpired(nowMs: number): boolean {
  let pruned = false;
  for (const [runId, record] of recordsBySuperRunId) {
    if (nowMs - record.updatedAtMs > AUTHORITY_RECORD_TTL_MS) {
      recordsBySuperRunId.delete(runId);
      pruned = true;
    }
  }
  return pruned;
}

/** Monotone state lattice rank: live < headerless < terminal. */
const STATE_RANK: Record<McpOriginatorAuthorityState, number> = {
  live: 0,
  headerless: 1,
  terminal: 2,
};

/**
 * Merge two records for the same run under the monotone lattice: max floor,
 * max state, max timestamp. Never relaxes either side.
 */
function mergeRecords(
  a: AuthorityRecord,
  b: AuthorityRecord | undefined,
): AuthorityRecord {
  if (!b) return a;
  const floor = Math.max(a.floor ?? -1, b.floor ?? -1);
  return {
    ...(floor >= 0 ? { floor } : {}),
    state: STATE_RANK[a.state] >= STATE_RANK[b.state] ? a.state : b.state,
    updatedAtMs: Math.max(a.updatedAtMs, b.updatedAtMs),
  };
}

/**
 * Read the durable file. `degraded: true` means the file EXISTS but could
 * not be read, parsed, or fully validated: the durable floor/retirement
 * state is unknown, so callers must fail CLOSED (deny admission, deny token
 * use) and must never overwrite the damaged file — writing a fresh file
 * over it would erase a persisted headerless/terminal boundary and let a
 * duplicate re-arm authority the operator already revoked (evil-shub
 * round-5 P1). A missing file is NOT degraded: nothing was ever persisted.
 */
function readAuthorityRecords(path: string): {
  records: Map<string, AuthorityRecord>;
  degraded: boolean;
} {
  const records = new Map<string, AuthorityRecord>();
  if (!existsSync(path)) return { records, degraded: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AuthorityFile;
    if (parsed?.version !== 1 || typeof parsed.records !== "object")
      return { records, degraded: true };
    for (const [runId, record] of Object.entries(parsed.records)) {
      if (
        record &&
        (record.state === "live" ||
          record.state === "headerless" ||
          record.state === "terminal") &&
        typeof record.updatedAtMs === "number"
      ) {
        records.set(runId, record);
      } else {
        // Any structurally invalid entry means the file's floors and states
        // cannot be trusted as complete.
        return { records, degraded: true };
      }
    }
    return { records, degraded: false };
  } catch {
    return { records, degraded: true };
  }
}

/**
 * Write with the same discipline as the disposition ledger: unique tmp file,
 * fsync before rename, fsync the directory after. Throws on failure — the
 * caller decides whether the mutation must degrade to in-memory only.
 */
function writeAuthorityRecords(
  path: string,
  records: Map<string, AuthorityRecord>,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const file: AuthorityFile = {
    version: 1,
    records: Object.fromEntries(records),
  };
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600, flag: "wx" });
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
}

/**
 * Serialized read-modify-write against the durable file. Every transaction
 * re-reads under an interprocess lock and merges, so concurrent listener
 * processes (CLI + desktop + teleport peers share the server-scoped file)
 * compose their records instead of last-writer-wins whole-file clobbers.
 * The in-memory map is a cache refreshed by each transaction — never the
 * source of a durable write.
 *
 * Degraded reads (corrupt/unreadable existing file) NEVER merge disk into
 * memory and NEVER write back: the in-memory overlay — which holds every
 * boundary this process has durably applied or failed-closed on — stays the
 * authority for this process, and the damaged file is left untouched for
 * inspection or recovery. The mutate callback receives the degradation flag
 * so gates can fail closed instead of judging an empty record set.
 */
function authorityTransaction<T>(
  mutate: (
    records: Map<string, AuthorityRecord>,
    ctx: { degraded: boolean },
  ) => {
    result: T;
    changed: boolean;
  },
): T {
  const path = authorityPersistentPath();
  if (!path) {
    // Persistence disabled (tests / unconfigured): in-memory only.
    return mutate(recordsBySuperRunId, { degraded: false }).result;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const release = acquireDurableFileLock(path, { waitMs: 2_000 });
  try {
    const { records: disk, degraded } = readAuthorityRecords(path);
    if (!degraded) {
      // Merge disk with the in-memory overlay instead of replacing it. The
      // state lattice (live < headerless < terminal) and floor are monotone,
      // so merging is well-defined — and an in-memory mark whose durable
      // write failed is never silently regressed by a later disk read.
      const memory = new Map(recordsBySuperRunId);
      recordsBySuperRunId.clear();
      for (const [runId, record] of disk) {
        recordsBySuperRunId.set(
          runId,
          mergeRecords(record, memory.get(runId)) ?? record,
        );
      }
      for (const [runId, record] of memory) {
        if (!disk.has(runId)) recordsBySuperRunId.set(runId, record);
      }
      pruneExpired(Date.now());
    }
    const { result, changed } = mutate(recordsBySuperRunId, { degraded });
    if (changed && !degraded) writeAuthorityRecords(path, recordsBySuperRunId);
    return result;
  } finally {
    release();
  }
}

/**
 * Apply a mutation durable-first; on any persistence failure (after
 * retries), still apply it to the in-memory map (fail-closed for the live
 * process) and log EVERY failure — a silently swallowed persist error
 * re-opens the boundary after restart, so each one must be visible.
 *
 * Returns true only when the boundary is DURABLE (or persistence is
 * disabled by configuration, where in-memory is the whole contract) —
 * callers that ACK frames or drop volatile state on success must treat
 * false as "the boundary holds in this process only" and must NOT report
 * the operation as durably complete (evil-shub round-5 P1).
 */
function mutateDurableFirst(
  label: string,
  mutate: (records: Map<string, AuthorityRecord>) => void,
): boolean {
  if (!authorityPersistentPath()) {
    mutate(recordsBySuperRunId);
    return true;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const persisted = authorityTransaction((records, ctx) => {
        if (ctx.degraded) return { result: false, changed: false };
        mutate(records);
        return { result: true, changed: true };
      });
      if (persisted) return true;
      // Degraded durable file: do NOT clobber it. Apply in-memory only.
      console.error(
        `[mcp-originator-authority] durable file is degraded for ${label}; the boundary holds in this process but is NOT durable across restart`,
      );
      mutate(recordsBySuperRunId);
      return false;
    } catch (error) {
      console.error(
        `[mcp-originator-authority] durable write failed for ${label} (attempt ${attempt}/3)`,
        error,
      );
    }
  }
  console.error(
    `[mcp-originator-authority] durable write failed for ${label} after retries; the boundary still holds in this process but is NOT durable across restart`,
  );
  mutate(recordsBySuperRunId);
  return false;
}

function touchRecords(
  records: Map<string, AuthorityRecord>,
  runId: string,
  generation: number | undefined,
  state?: McpOriginatorAuthorityState,
): void {
  const existing = records.get(runId);
  const floor =
    generation === undefined
      ? existing?.floor
      : Math.max(existing?.floor ?? -1, generation);
  records.set(runId, {
    ...(floor !== undefined ? { floor } : {}),
    // State is monotone: headerless/terminal, once set, are never relaxed by
    // later deliveries — that monotonicity IS the fail-closed boundary.
    state: state ?? existing?.state ?? "live",
    updatedAtMs: Date.now(),
  });
}

/**
 * Record an accepted originator delivery (any kind: token, tombstone).
 * Bumps the generation floor; never relaxes a headerless/terminal state.
 * Returns false when the floor bump could not be persisted (see
 * mutateDurableFirst) — callers must not treat the delivery as durably
 * recorded.
 */
export function noteMcpOriginatorDelivery(
  runId: string,
  generation: number | undefined,
): boolean {
  return mutateDurableFirst(`floor bump for ${runId}`, (records) =>
    touchRecords(records, runId, generation),
  );
}

/**
 * Atomic admission: evaluate the gate AND, when it passes, durably bump the
 * generation floor — both inside ONE locked transaction (evil-shub round-5
 * P1). The pre-round-6 allows() + note() pair released the lock between the
 * check and the floor write, so a concurrent process could advance the
 * floor or mark the run headerless/terminal in the gap and this process
 * would still install its stale token. Here the check, the floor write, and
 * the durable persistence are indivisible: if the durable write fails, the
 * whole transaction throws and admission is DENIED (fail closed — the
 * caller drops the delivery and does not ACK, so redelivery retries).
 * A degraded durable file also denies: the persisted boundary is unknown.
 */
export function admitMcpOriginatorDelivery(
  runId: string,
  generation: number | undefined,
): boolean {
  if (!authorityPersistentPath()) {
    const record = recordsBySuperRunId.get(runId);
    if (record) {
      if (record.state !== "live") return false;
      if (
        record.floor !== undefined &&
        (generation === undefined || generation < record.floor)
      )
        return false;
    }
    touchRecords(recordsBySuperRunId, runId, generation);
    return true;
  }
  try {
    return authorityTransaction((records, ctx) => {
      if (ctx.degraded) {
        console.error(
          `[mcp-originator-authority] durable file is degraded; denying admission for ${runId} (fail-closed)`,
        );
        return { result: false, changed: false };
      }
      const record = records.get(runId);
      if (record) {
        if (record.state !== "live") return { result: false, changed: false };
        if (
          record.floor !== undefined &&
          (generation === undefined || generation < record.floor)
        )
          return { result: false, changed: false };
      }
      touchRecords(records, runId, generation);
      return { result: true, changed: true };
    });
  } catch (error) {
    console.error(
      `[mcp-originator-authority] admission transaction failed for ${runId}; denying the delivery (fail-closed)`,
      error,
    );
    return false;
  }
}

/**
 * Use-time authority recheck for token handout (evil-shub round-5 P1): the
 * admission gate only runs at delivery; a revoked or deliberately retired
 * run must not keep spending its token. Consulted by getMcpOriginatorToken
 * on every scoped call: a non-live state or a floor ahead of the held
 * generation withdraws the token (the call proceeds unattributed). Fail
 * closed on degraded/unreadable durable state.
 */
export function mcpOriginatorAuthorityPermitsUse(
  runId: string,
  generation: number | undefined,
): boolean {
  try {
    return authorityTransaction((records, ctx) => {
      if (ctx.degraded) return { result: false, changed: false };
      const record = records.get(runId);
      if (!record) return { result: true, changed: false };
      if (record.state !== "live") return { result: false, changed: false };
      if (
        record.floor !== undefined &&
        generation !== undefined &&
        generation < record.floor
      )
        return { result: false, changed: false };
      return { result: true, changed: false };
    });
  } catch (error) {
    console.error(
      `[mcp-originator-authority] use check failed for ${runId}; withdrawing the token (fail-closed)`,
      error,
    );
    return false;
  }
}

/**
 * Mark a run's authority deliberately retired mid-turn (approval origin
 * swap, mixed-batch merge): the continuation must stay headerless, so no
 * later delivery of ANY generation may recreate the entry.
 */
export function markMcpOriginatorHeaderless(
  runId: string,
  deletedGeneration?: number,
): boolean {
  return mutateDurableFirst(`headerless mark for ${runId}`, (records) =>
    touchRecords(records, runId, deletedGeneration, "headerless"),
  );
}

/** Mark a run terminal: no later delivery may recreate the entry. */
export function markMcpOriginatorTerminal(
  runId: string,
  deletedGeneration?: number,
): boolean {
  return mutateDurableFirst(`terminal mark for ${runId}`, (records) =>
    touchRecords(records, runId, deletedGeneration, "terminal"),
  );
}

/**
 * Admission gate consulted before every create/refresh/tombstone write.
 * Rejects zombies below the floor, legacy deliveries beneath a known
 * generation contract, and ANY delivery for a headerless/terminal run.
 */
export function mcpOriginatorAuthorityAllows(
  runId: string,
  generation: number | undefined,
): boolean {
  try {
    return authorityTransaction((records, ctx) => {
      // Degraded durable state: the persisted boundary is unknown — deny
      // rather than judge an incomplete record set (fail closed).
      if (ctx.degraded) {
        console.error(
          `[mcp-originator-authority] durable file is degraded; denying the delivery for ${runId} (fail-closed)`,
        );
        return { result: false, changed: false };
      }
      const record = records.get(runId);
      let allows = true;
      if (record) {
        if (record.state !== "live") {
          allows = false;
        } else if (record.floor !== undefined) {
          if (generation === undefined || generation < record.floor)
            allows = false;
        }
      }
      return { result: allows, changed: false };
    });
  } catch (error) {
    // Fail closed: without the durable record we cannot prove the boundary,
    // so the delivery is dropped and the turn runs headerless.
    console.error(
      `[mcp-originator-authority] authority read failed for ${runId}; denying the delivery (fail-closed)`,
      error,
    );
    return false;
  }
}

/** Test-only: point persistence at a fixture path (null = in-memory only). */
export function configureMcpOriginatorAuthorityPersistenceForTests(
  path: string | null,
): void {
  persistencePathOverride = path;
}

/** Test-only: drop every record and forget any loaded state. */
export function resetMcpOriginatorAuthority(): void {
  recordsBySuperRunId.clear();
}

/** Test-only diagnostics. */
export function readMcpOriginatorAuthorityForTests(
  runId: string,
): { floor?: number; state: McpOriginatorAuthorityState } | undefined {
  const record = authorityTransaction((records) => ({
    result: records.get(runId),
    changed: false,
  }));
  return record
    ? {
        ...(record.floor !== undefined ? { floor: record.floor } : {}),
        state: record.state,
      }
    : undefined;
}
