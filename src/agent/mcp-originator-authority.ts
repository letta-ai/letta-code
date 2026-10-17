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

/**
 * A wire or disk generation is meaningful only as a nonnegative safe
 * integer (evil-shub round-6 P1): a string, negative, fractional, or NaN
 * value used to flow straight into Math.max, producing a NaN floor that
 * silently disabled every later floor comparison (NaN < x is false).
 */
function isValidGeneration(generation: unknown): generation is number {
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
function isValidUpdatedAtMs(
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
      if (
        record &&
        (record.state === "live" ||
          record.state === "headerless" ||
          record.state === "terminal") &&
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

/**
 * Pending retirement marks whose durable write has not landed yet
 * (evil-shub round-8 P1 durable retirement). A headerless/terminal mark
 * is a one-way boundary: the pre-round-8 behavior (three attempts, then
 * in-memory only) left a resurrection window — if persistence healed
 * AFTER the process gave up but BEFORE its restart, the durable file
 * still showed the run live and a duplicate could re-arm authority. The
 * marks below are retried UNBOUNDEDLY (bounded by the record TTL: the
 * file itself forgets the run after 2h) until they land, and the
 * in-memory overlay already denies admission/use for this process, so
 * the boundary is fail-closed everywhere while the retry is pending.
 */
const pendingRetirements = new Map<
  string,
  { state: "headerless" | "terminal"; generation?: number }
>();
let retirementRetryTimer: ReturnType<typeof setTimeout> | undefined;
const retirementRetryIntervalMs = 30_000;

function scheduleRetirementRetry(): void {
  if (pendingRetirements.size === 0) return;
  if (retirementRetryTimer !== undefined) return;
  if (process.env.NODE_ENV === "test") return; // Tests drive the driver below.
  retirementRetryTimer = setTimeout(() => {
    retirementRetryTimer = undefined;
    retryPendingMcpOriginatorRetirements();
  }, retirementRetryIntervalMs);
  retirementRetryTimer.unref?.();
}

/**
 * Re-attempt every pending retirement. Exported for the listener's
 * teardown hook and driven explicitly by tests; the timer path calls it
 * on an interval until the map drains.
 */
export function retryPendingMcpOriginatorRetirements(): void {
  for (const [runId, pending] of [...pendingRetirements]) {
    const durable = mutateDurableFirst(
      `retirement retry (${pending.state}) for ${runId}`,
      (records) =>
        touchRecords(records, runId, pending.generation, pending.state),
    );
    if (durable) pendingRetirements.delete(runId);
  }
  if (pendingRetirements.size > 0) scheduleRetirementRetry();
}

/**
 * Register a retirement that could not be persisted yet, and make sure a
 * retry is (or stays) scheduled. The in-memory mark is already applied by
 * mutateDurableFirst's failure path, so this process is fail-closed; the
 * retry closes the restart-resurrection window as soon as persistence
 * heals.
 */
function registerPendingRetirement(
  runId: string,
  state: "headerless" | "terminal",
  generation: number | undefined,
  durable: boolean,
): void {
  if (durable) {
    // A landed mark at a HIGHER-or-equal lattice rank subsumes a pending
    // retry for the same run; a pending terminal must survive a landed
    // headerless.
    const pending = pendingRetirements.get(runId);
    if (pending && STATE_RANK[pending.state] <= STATE_RANK[state]) {
      pendingRetirements.delete(runId);
    }
    return;
  }
  const existing = pendingRetirements.get(runId);
  const merged: { state: "headerless" | "terminal"; generation?: number } = {
    state:
      existing && STATE_RANK[existing.state] > STATE_RANK[state]
        ? existing.state
        : state,
  };
  const mergedGeneration = generation ?? existing?.generation;
  if (mergedGeneration !== undefined) merged.generation = mergedGeneration;
  pendingRetirements.set(runId, merged);
  scheduleRetirementRetry();
}

/** Test-only: pending retirements, for asserting retry registration. */
export function readPendingMcpOriginatorRetirementsForTests(): ReadonlyMap<
  string,
  { state: "headerless" | "terminal"; generation?: number }
> {
  return pendingRetirements;
}

function touchRecords(
  records: Map<string, AuthorityRecord>,
  runId: string,
  generation: number | undefined,
  state?: McpOriginatorAuthorityState,
): void {
  const existing = records.get(runId);
  // Defense in depth (evil-shub round-6 P1): never let a malformed
  // generation write a NaN/garbage floor into the monotone lattice; the
  // public entry points already reject such values fail-closed, so
  // reaching this branch means the caller kept only the state transition.
  const usableGeneration =
    generation !== undefined && isValidGeneration(generation)
      ? generation
      : undefined;
  const floor =
    usableGeneration === undefined
      ? existing?.floor
      : Math.max(existing?.floor ?? -1, usableGeneration);
  // State is monotone: headerless/terminal, once set, are never relaxed by
  // later deliveries or retirement marks — that monotonicity IS the
  // fail-closed boundary. A headerless mark landing after a terminal mark
  // (retries can arrive in any order across processes) must NOT regress the
  // record: take the lattice maximum instead of overwriting.
  const nextState =
    state === undefined
      ? (existing?.state ?? "live")
      : existing?.state !== undefined &&
          STATE_RANK[existing.state] > STATE_RANK[state]
        ? existing.state
        : state;
  records.set(runId, {
    ...(floor !== undefined ? { floor } : {}),
    state: nextState,
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
/**
 * Admission outcome (evil-shub round-8 P1 verdict split). A PERMANENT
 * denial means this exact delivery can never be admitted — a stale
 * generation at-or-below the durable floor, a legacy delivery beneath a
 * known generation contract, a headerless/terminal run, or a malformed
 * generation. Redelivering it would loop forever, so the caller must
 * consume/drop the frame (no work, no redelivery). A RETRYABLE denial
 * means the durable boundary could not be evaluated at all (degraded
 * durable file, failed transaction): the caller must not commit work and
 * must not ACK, so redelivery retries the whole admission once the
 * infrastructure heals.
 */
export type McpOriginatorAdmission =
  | { admitted: true }
  | { admitted: false; permanent: boolean };

export function admitMcpOriginatorDelivery(
  runId: string,
  generation: number | undefined,
): McpOriginatorAdmission {
  // A malformed generation can never be a healthy admission (evil-shub
  // round-6 P1): the durable floor was never bumped for it, so consuming
  // the frame (permanent) does not block a later well-formed delivery.
  if (generation !== undefined && !isValidGeneration(generation)) {
    console.error(
      `[mcp-originator-authority] malformed generation for ${runId}; denying admission (fail-closed)`,
    );
    return { admitted: false, permanent: true };
  }
  if (!authorityPersistentPath()) {
    const record = recordsBySuperRunId.get(runId);
    if (record) {
      if (record.state !== "live") return { admitted: false, permanent: true };
      if (
        record.floor !== undefined &&
        (generation === undefined || generation < record.floor)
      )
        return { admitted: false, permanent: true };
    }
    touchRecords(recordsBySuperRunId, runId, generation);
    return { admitted: true };
  }
  try {
    return authorityTransaction<McpOriginatorAdmission>((records, ctx) => {
      if (ctx.degraded) {
        console.error(
          `[mcp-originator-authority] durable file is degraded; denying admission for ${runId} (fail-closed, retryable)`,
        );
        return {
          result: { admitted: false, permanent: false },
          changed: false,
        };
      }
      const record = records.get(runId);
      if (record) {
        if (record.state !== "live")
          return {
            result: { admitted: false, permanent: true },
            changed: false,
          };
        if (
          record.floor !== undefined &&
          (generation === undefined || generation < record.floor)
        )
          return {
            result: { admitted: false, permanent: true },
            changed: false,
          };
      }
      touchRecords(records, runId, generation);
      return { result: { admitted: true }, changed: true };
    });
  } catch (error) {
    console.error(
      `[mcp-originator-authority] admission transaction failed for ${runId}; denying the delivery (fail-closed, retryable)`,
      error,
    );
    return { admitted: false, permanent: false };
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
  // A malformed held generation cannot be compared against the floor:
  // withdraw the token rather than guess (fail-closed; evil-shub round-6 P1).
  if (generation !== undefined && !isValidGeneration(generation)) {
    console.error(
      `[mcp-originator-authority] malformed generation for ${runId}; withdrawing the token (fail-closed)`,
    );
    return false;
  }
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
  const durable = mutateDurableFirst(
    `headerless mark for ${runId}`,
    (records) => touchRecords(records, runId, deletedGeneration, "headerless"),
  );
  registerPendingRetirement(runId, "headerless", deletedGeneration, durable);
  return durable;
}

/** Mark a run terminal: no later delivery may recreate the entry. */
export function markMcpOriginatorTerminal(
  runId: string,
  deletedGeneration?: number,
): boolean {
  const durable = mutateDurableFirst(`terminal mark for ${runId}`, (records) =>
    touchRecords(records, runId, deletedGeneration, "terminal"),
  );
  registerPendingRetirement(runId, "terminal", deletedGeneration, durable);
  return durable;
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
  pendingRetirements.clear();
  if (retirementRetryTimer !== undefined) {
    clearTimeout(retirementRetryTimer);
    retirementRetryTimer = undefined;
  }
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
