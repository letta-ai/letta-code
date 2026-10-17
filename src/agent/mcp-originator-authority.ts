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

function readAuthorityRecords(path: string): Map<string, AuthorityRecord> {
  const records = new Map<string, AuthorityRecord>();
  if (!existsSync(path)) return records;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AuthorityFile;
    if (parsed?.version !== 1 || typeof parsed.records !== "object")
      return records;
    for (const [runId, record] of Object.entries(parsed.records)) {
      if (
        record &&
        (record.state === "live" ||
          record.state === "headerless" ||
          record.state === "terminal") &&
        typeof record.updatedAtMs === "number"
      ) {
        records.set(runId, record);
      }
    }
  } catch {
    // Corrupt or unreadable file: treat as empty rather than blocking input.
  }
  return records;
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
 */
function authorityTransaction<T>(
  mutate: (records: Map<string, AuthorityRecord>) => {
    result: T;
    changed: boolean;
  },
): T {
  const path = authorityPersistentPath();
  if (!path) {
    // Persistence disabled (tests / unconfigured): in-memory only.
    return mutate(recordsBySuperRunId).result;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const release = acquireDurableFileLock(path, { waitMs: 2_000 });
  try {
    const disk = readAuthorityRecords(path);
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
    const { result, changed } = mutate(recordsBySuperRunId);
    if (changed) writeAuthorityRecords(path, recordsBySuperRunId);
    return result;
  } finally {
    release();
  }
}

/**
 * Apply a mutation durable-first; on any persistence failure, still apply it
 * to the in-memory map (fail-closed for the live process) and log EVERY
 * failure — a silently swallowed persist error re-opens the boundary after
 * restart, so each one must be visible.
 */
function mutateDurableFirst(
  label: string,
  mutate: (records: Map<string, AuthorityRecord>) => void,
): void {
  try {
    authorityTransaction((records) => {
      mutate(records);
      return { result: undefined, changed: true };
    });
  } catch (error) {
    console.error(
      `[mcp-originator-authority] durable write failed for ${label}; the boundary still holds in this process but is NOT durable across restart`,
      error,
    );
    mutate(recordsBySuperRunId);
  }
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
 */
export function noteMcpOriginatorDelivery(
  runId: string,
  generation: number | undefined,
): void {
  mutateDurableFirst(`floor bump for ${runId}`, (records) =>
    touchRecords(records, runId, generation),
  );
}

/**
 * Mark a run's authority deliberately retired mid-turn (approval origin
 * swap, mixed-batch merge): the continuation must stay headerless, so no
 * later delivery of ANY generation may recreate the entry.
 */
export function markMcpOriginatorHeaderless(
  runId: string,
  deletedGeneration?: number,
): void {
  mutateDurableFirst(`headerless mark for ${runId}`, (records) =>
    touchRecords(records, runId, deletedGeneration, "headerless"),
  );
}

/** Mark a run terminal: no later delivery may recreate the entry. */
export function markMcpOriginatorTerminal(
  runId: string,
  deletedGeneration?: number,
): void {
  mutateDurableFirst(`terminal mark for ${runId}`, (records) =>
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
    return authorityTransaction((records) => {
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
