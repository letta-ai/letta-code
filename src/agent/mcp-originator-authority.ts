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
 * Persistence is best-effort: the in-memory mirror stays authoritative for
 * the process lifetime; a failed write degrades cross-restart protection
 * only and is logged, never thrown into the input path.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getServerUrl } from "@/backend/api/server-url";

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
let loadedFromDisk = false;
let writeFailureLogged = false;

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

function loadFromDiskOnce(): void {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  const path = authorityPersistentPath();
  if (!path || !existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AuthorityFile;
    if (parsed?.version !== 1 || typeof parsed.records !== "object") return;
    for (const [runId, record] of Object.entries(parsed.records)) {
      if (
        record &&
        (record.state === "live" ||
          record.state === "headerless" ||
          record.state === "terminal") &&
        typeof record.updatedAtMs === "number"
      ) {
        recordsBySuperRunId.set(runId, record);
      }
    }
    pruneExpired(Date.now());
  } catch {
    // Corrupt or unreadable file: start empty rather than blocking input.
  }
}

function persist(): void {
  const path = authorityPersistentPath();
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const file: AuthorityFile = {
      version: 1,
      records: Object.fromEntries(recordsBySuperRunId),
    };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    if (!writeFailureLogged) {
      writeFailureLogged = true;
      console.warn(
        "[mcp-originator-authority] durable write failed; in-memory records remain authoritative for this process",
        error,
      );
    }
  }
}

function touch(
  runId: string,
  generation: number | undefined,
  state?: McpOriginatorAuthorityState,
): void {
  loadFromDiskOnce();
  const existing = recordsBySuperRunId.get(runId);
  const floor =
    generation === undefined
      ? existing?.floor
      : Math.max(existing?.floor ?? -1, generation);
  recordsBySuperRunId.set(runId, {
    ...(floor !== undefined ? { floor } : {}),
    // State is monotone: headerless/terminal, once set, are never relaxed by
    // later deliveries — that monotonicity IS the fail-closed boundary.
    state: state ?? existing?.state ?? "live",
    updatedAtMs: Date.now(),
  });
  pruneExpired(Date.now());
  persist();
}

/**
 * Record an accepted originator delivery (any kind: token, tombstone).
 * Bumps the generation floor; never relaxes a headerless/terminal state.
 */
export function noteMcpOriginatorDelivery(
  runId: string,
  generation: number | undefined,
): void {
  touch(runId, generation);
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
  touch(runId, deletedGeneration, "headerless");
}

/** Mark a run terminal: no later delivery may recreate the entry. */
export function markMcpOriginatorTerminal(
  runId: string,
  deletedGeneration?: number,
): void {
  touch(runId, deletedGeneration, "terminal");
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
  loadFromDiskOnce();
  pruneExpired(Date.now());
  const record = recordsBySuperRunId.get(runId);
  if (!record) return true;
  if (record.state !== "live") return false;
  if (record.floor !== undefined) {
    if (generation === undefined) return false;
    if (generation < record.floor) return false;
  }
  return true;
}

/** Test-only: point persistence at a fixture path (null = in-memory only). */
export function configureMcpOriginatorAuthorityPersistenceForTests(
  path: string | null,
): void {
  persistencePathOverride = path;
  loadedFromDisk = false;
}

/** Test-only: drop every record and forget any loaded state. */
export function resetMcpOriginatorAuthority(): void {
  recordsBySuperRunId.clear();
  loadedFromDisk = false;
  writeFailureLogged = false;
}

/** Test-only diagnostics. */
export function readMcpOriginatorAuthorityForTests(
  runId: string,
): { floor?: number; state: McpOriginatorAuthorityState } | undefined {
  loadFromDiskOnce();
  const record = recordsBySuperRunId.get(runId);
  return record
    ? {
        ...(record.floor !== undefined ? { floor: record.floor } : {}),
        state: record.state,
      }
    : undefined;
}
