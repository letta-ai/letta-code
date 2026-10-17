/**
 * Durable-file layer for MCP originator authority records: types, wire
 * validation, lattice merges, path resolution, and the locked whole-file
 * read/write primitives. Split out of mcp-originator-authority.ts so both
 * modules stay under the source-file size limit; all policy (gates,
 * transactions, pending retirements) lives in the parent module.
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
import { fsyncDirectory } from "@/websocket/listener/durable-file-lock";

export type McpOriginatorAuthorityState = "live" | "headerless" | "terminal";

/** The non-live end states a retirement can target. */
export type McpOriginatorRetirementState = Exclude<
  McpOriginatorAuthorityState,
  "live"
>;

export type AuthorityRecord = {
  /** Highest mint generation observed for this run (any delivery kind). */
  floor?: number;
  state: McpOriginatorAuthorityState;
  /**
   * Durable retirement intent (evil-shub round-9 P1): set when the actual
   * headerless/terminal mark could not be persisted. Every gate treats a
   * record carrying an intent as NOT live, so peers fail closed even though
   * the final state never landed; cleared when the mark lands.
   */
  retiringTo?: McpOriginatorRetirementState;
  updatedAtMs: number;
};

/**
 * A wire or disk generation is meaningful only as a nonnegative safe
 * integer (evil-shub round-6 P1): a string, negative, fractional, or NaN
 * value used to flow straight into Math.max, producing a NaN floor that
 * silently disabled every later floor comparison (NaN < x is false).
 */
export function isValidGeneration(generation: unknown): generation is number {
  return (
    typeof generation === "number" &&
    Number.isSafeInteger(generation) &&
    generation >= 0
  );
}

/** Clock skew tolerance for records written by a peer with a fast clock. */
const UPDATED_AT_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * A record timestamp is meaningful only as a nonnegative safe integer not
 * impossibly far in the future (evil-shub round-8 P1). A negative or NaN
 * value flows into pruneExpired as `now - t > TTL` = always true, erasing
 * live/terminal boundaries on the very next access — a fail-OPEN read of a
 * corrupt file. A far-future value never prunes, pinning a stale floor.
 */
export function isValidUpdatedAtMs(
  updatedAtMs: unknown,
  nowMs: number,
): updatedAtMs is number {
  return (
    typeof updatedAtMs === "number" &&
    Number.isSafeInteger(updatedAtMs) &&
    updatedAtMs >= 0 &&
    updatedAtMs <= nowMs + UPDATED_AT_FUTURE_SKEW_MS
  );
}

type AuthorityFile = {
  version: 1;
  records: Record<string, AuthorityRecord>;
};

let persistencePathOverride: string | null | undefined;

/** Test-only: point persistence at a fixture path (null = in-memory only). */
export function configureAuthorityPersistencePathForTests(
  path: string | null,
): void {
  persistencePathOverride = path;
}

export function authorityPersistentPath(): string | null {
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

export const STATE_RANK: Record<McpOriginatorAuthorityState, number> = {
  live: 0,
  headerless: 1,
  terminal: 2,
};

/**
 * Merge a durable retirement intent under the same monotonicity as the
 * state lattice: once expressed, an intent is never silently relaxed, and a
 * pending terminal subsumes a pending headerless. Intents are meaningless
 * once the record left `live` (the landed mark is the stronger boundary).
 */
export function mergeRetirementIntents(
  a: McpOriginatorRetirementState | undefined,
  b: McpOriginatorRetirementState | undefined,
): McpOriginatorRetirementState | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return STATE_RANK[a] >= STATE_RANK[b] ? a : b;
}

/**
 * Merge two records for the same run under the monotone lattice: max floor,
 * max state, max timestamp, strongest retirement intent. Never relaxes
 * either side.
 */
export function mergeRecords(
  a: AuthorityRecord,
  b: AuthorityRecord | undefined,
): AuthorityRecord {
  if (!b) return a;
  const floor = Math.max(a.floor ?? -1, b.floor ?? -1);
  const state = STATE_RANK[a.state] >= STATE_RANK[b.state] ? a.state : b.state;
  const retiringTo =
    state === "live"
      ? mergeRetirementIntents(a.retiringTo, b.retiringTo)
      : undefined;
  return {
    ...(floor >= 0 ? { floor } : {}),
    state,
    ...(retiringTo !== undefined ? { retiringTo } : {}),
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
export function readAuthorityRecords(path: string): {
  records: Map<string, AuthorityRecord>;
  degraded: boolean;
} {
  const records = new Map<string, AuthorityRecord>();
  if (!existsSync(path)) return { records, degraded: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    // Strict top-level shape (evil-shub round-8 P1): `records` must be a
    // plain object — an ARRAY passes `typeof === "object"` and used to read
    // as a healthy EMPTY file, silently dropping every persisted boundary
    // (a terminal run would admit a post-terminal duplicate).
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { records?: unknown }).records !== "object" ||
      (parsed as { records?: unknown }).records === null ||
      Array.isArray((parsed as { records?: unknown }).records)
    )
      return { records, degraded: true };
    const nowMs = Date.now();
    for (const [runId, record] of Object.entries(
      (parsed as AuthorityFile).records,
    )) {
      const retiringTo = (record as AuthorityRecord | undefined)?.retiringTo;
      if (
        record &&
        (record.state === "live" ||
          record.state === "headerless" ||
          record.state === "terminal") &&
        // A retirement intent is meaningful only as one of the two non-live
        // end states; anything else means the file cannot be trusted — the
        // same whole-file fail-closed rule as an invalid state or floor
        // (evil-shub round-9 P1). An intent attached to a record that
        // already left `live` is redundant, not corrupt: the landed state is
        // the stronger boundary, so the intent is normalized away on read.
        (retiringTo === undefined ||
          retiringTo === "headerless" ||
          retiringTo === "terminal") &&
        // updatedAtMs drives TTL pruning: a negative or far-future value is
        // not merely odd data — a negative one makes every record look
        // expired (prune erases a terminal boundary → fail-open), and a
        // far-future one pins a stale floor against pruning forever.
        // Either means the file cannot be trusted: degrade the WHOLE file
        // fail-closed rather than reinterpret it (evil-shub round-8 P1).
        isValidUpdatedAtMs(record.updatedAtMs, nowMs) &&
        // A structurally invalid floor (string/negative/fractional/NaN) is
        // as untrustworthy as an invalid state: treat the whole file as
        // degraded rather than let a bogus floor silently gate admission
        // (evil-shub round-6 P1).
        (record.floor === undefined || isValidGeneration(record.floor))
      ) {
        records.set(runId, {
          ...(record.floor !== undefined ? { floor: record.floor } : {}),
          state: record.state,
          // Normalize away a redundant intent on a non-live record (the
          // landed state is the stronger boundary).
          ...(record.state === "live" && retiringTo !== undefined
            ? { retiringTo }
            : {}),
          updatedAtMs: record.updatedAtMs,
        });
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
export function writeAuthorityRecords(
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
