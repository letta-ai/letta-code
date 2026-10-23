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
 *   { floor?: number; state: "live" | "headerless" | "terminal";
 *     retiringTo?: "headerless" | "terminal"; updatedAtMs }
 *
 * floor is the maximum observed mint generation; state transitions only ever
 * move live → headerless|terminal (never back), mirroring the fail-closed
 * intent of the boundaries that set them. retiringTo is a durable retirement
 * INTENT (evil-shub round-9 P1): when a headerless/terminal mark cannot be
 * persisted, the intent is written instead so peers treat the record as NOT
 * live (fail closed for admission and token use) and a restarted process
 * reloads the pending retirement and resumes the retry. Records survive
 * process restarts in the same ~/.letta/state/<server-namespace>/ directory
 * as the accepted input disposition ledger.
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

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { acquireDurableFileLock } from "@/websocket/listener/durable-file-lock";
import {
  type AuthorityRecord,
  authorityPersistentPath,
  configureAuthorityPersistencePathForTests,
  isValidGeneration,
  type McpOriginatorAuthorityState,
  type McpOriginatorRetirementState,
  mergeRecords,
  mergeRetirementIntents,
  readAuthorityRecords,
  STATE_RANK,
  writeAuthorityRecords,
} from "./mcp-originator-authority-file";

export type {
  McpOriginatorAuthorityState,
  McpOriginatorRetirementState,
} from "./mcp-originator-authority-file";

/** Twice the server-side 1h absolute token ceiling. */
const AUTHORITY_RECORD_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Effective record TTL; tests may shorten it (never in production — the
 * setter below is test-only) so the pending-retirement drop and pruning can
 * be exercised without a two-hour wait.
 */
let recordTtlMs = AUTHORITY_RECORD_TTL_MS;

const recordsBySuperRunId = new Map<string, AuthorityRecord>();

function pruneExpired(nowMs: number): boolean {
  let pruned = false;
  for (const [runId, record] of recordsBySuperRunId) {
    if (nowMs - record.updatedAtMs > recordTtlMs) {
      recordsBySuperRunId.delete(runId);
      pruned = true;
    }
  }
  return pruned;
}

/** Monotone state lattice rank: live < headerless < terminal. */

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
      // A peer (or a dead earlier incarnation of this process) may have
      // persisted a retirement INTENT whose mark never landed: reload it so
      // this process resumes the retry instead of treating the run as
      // ordinarily live (evil-shub round-9 P1).
      resumeDurableRetirementIntents();
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
 * marks below are retried until they land or outlive the record TTL (evil-
 * shub round-9 P1: past twice the server-side 1h token ceiling, every
 * token the boundary could fence is dead, so the retry is dropped loudly
 * instead of storming forever). The retry also PERSISTS THE INTENT
 * (`retiringTo`) the moment a mark fails: peers reading the file treat an
 * intent-carrying record as NOT live (fail closed for admission and token
 * use), and a restarted process reloads the intent and resumes the retry
 * instead of losing the boundary at process death. The in-memory overlay
 * already denies admission/use for this process, so the boundary is
 * fail-closed everywhere while the retry is pending.
 */
const pendingRetirements = new Map<
  string,
  {
    state: McpOriginatorRetirementState;
    generation?: number;
    /**
     * First registration time; drives the TTL drop. Never refreshed by
     * retries — the bound is measured from when the retirement was first
     * needed, not from the last failed attempt.
     */
    createdAtMs: number;
  }
>();
let retirementRetryTimer: ReturnType<typeof setTimeout> | undefined;
const retirementRetryIntervalMs = 30_000;
/**
 * Per-tick work bound (evil-shub round-9 P1): each entry performs up to
 * three synchronous interprocess lock/write attempts, so iterating the
 * whole map in one tick could stall the listener event loop without bound
 * on persistent storage failure. Process at most this many entries per
 * tick and requeue the rest for the next tick.
 */
const MAX_RETIREMENT_RETRIES_PER_TICK = 25;

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
  const nowMs = Date.now();
  let processed = 0;
  // Direct iteration: this loop only deletes entries (never re-adds), which
  // a live Map iterator tolerates.
  for (const [runId, pending] of pendingRetirements) {
    // TTL drop (evil-shub round-9 P1): past twice the 1h token ceiling the
    // record itself is prunable and every token the boundary could fence is
    // dead server-side — retirement is moot. Drop loudly, never silently.
    if (nowMs - pending.createdAtMs > recordTtlMs) {
      console.error(
        `[mcp-originator-authority] pending ${pending.state} retirement for ${runId} outlived the ${Math.round(recordTtlMs / 60_000)}-minute record TTL; dropping the retry (any token it fenced is dead at the server-side ceiling)`,
      );
      pendingRetirements.delete(runId);
      continue;
    }
    if (processed >= MAX_RETIREMENT_RETRIES_PER_TICK) {
      // Bound per-tick synchronous work; the remainder is retried on the
      // next scheduled tick (scheduled below since the map is non-empty).
      continue;
    }
    processed += 1;
    const durable = mutateDurableFirst(
      `retirement retry (${pending.state}) for ${runId}`,
      (records) =>
        touchRecords(records, runId, pending.generation, pending.state, {
          preserveUpdatedAt: true,
        }),
    );
    if (durable) pendingRetirements.delete(runId);
  }
  if (pendingRetirements.size > 0) scheduleRetirementRetry();
}

/**
 * Persist ONLY the retirement intent (`retiringTo`) for a mark that just
 * failed to land (evil-shub round-9 P1). The full mark keeps retrying via
 * the pending map; the intent is the cheap durable signal that lets peers
 * fail closed in the gap and lets a restarted process resume the retry.
 *
 * This is deliberately a DISK-ONLY transaction that bypasses the in-memory
 * overlay: the overlay already carries the failed mark at its final state,
 * so an overlay-merged write would persist the whole mark instead of the
 * intent — and whenever the intent cannot outlive the mark, a restart has
 * nothing to resume from. Writing the intent alone gives the file a
 * durable "live but being retired" boundary even when the mark itself
 * never landed before process death. Best-effort like every mark here: a
 * failed intent write logs loudly and the in-memory overlay stays
 * fail-closed for this process.
 */
function persistRetirementIntent(
  runId: string,
  state: McpOriginatorRetirementState,
  generation: number | undefined,
): void {
  const path = authorityPersistentPath();
  if (!path) return; // Persistence disabled (tests): the overlay is all.
  try {
    const release = acquireDurableFileLock(path, { waitMs: 2_000 });
    try {
      const { records: disk, degraded } = readAuthorityRecords(path);
      if (degraded) {
        console.error(
          `[mcp-originator-authority] durable file is degraded for the retirement intent (${state}) for ${runId}; the boundary holds in this process only`,
        );
        return;
      }
      const existing = disk.get(runId);
      // A landed headerless/terminal mark is the stronger boundary; never
      // regress it to an intent.
      if (existing && existing.state !== "live") return;
      const floor =
        generation !== undefined && isValidGeneration(generation)
          ? Math.max(existing?.floor ?? -1, generation)
          : existing?.floor;
      disk.set(runId, {
        ...(floor !== undefined && floor >= 0 ? { floor } : {}),
        state: "live",
        retiringTo:
          mergeRetirementIntents(existing?.retiringTo, state) ?? state,
        // Keep the record's original age: the TTL drop measures from the
        // retirement's first need, and refreshing here would pin a stale
        // boundary past the token ceiling.
        updatedAtMs: existing?.updatedAtMs ?? Date.now(),
      });
      writeAuthorityRecords(path, disk);
    } finally {
      release();
    }
  } catch (error) {
    console.error(
      `[mcp-originator-authority] durable retirement intent (${state}) write failed for ${runId}; peers cannot see the boundary until a retry lands the mark`,
      error,
    );
  }
}

/**
 * Resume durable retirement intents after a restart (evil-shub round-9 P1):
 * a record read from disk as live-with-`retiringTo` is a retirement a dead
 * process never landed. Re-register it so the retry driver keeps attempting
 * the mark; createdAtMs is the record's persisted age, so the TTL drop
 * still measures from the retirement's first need, not the restart.
 */
function resumeDurableRetirementIntents(): void {
  for (const [runId, record] of recordsBySuperRunId) {
    if (record.state !== "live" || record.retiringTo === undefined) continue;
    const existing = pendingRetirements.get(runId);
    if (existing && existing.createdAtMs <= record.updatedAtMs) continue;
    pendingRetirements.set(runId, {
      state: record.retiringTo,
      ...(record.floor !== undefined ? { generation: record.floor } : {}),
      createdAtMs: Math.min(
        existing?.createdAtMs ?? record.updatedAtMs,
        record.updatedAtMs,
      ),
    });
  }
  scheduleRetirementRetry();
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
  state: McpOriginatorRetirementState,
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
  // The mark is not durable: persist the INTENT before anything else so
  // peers and future restarts fail closed even if this process dies before
  // the first retry (evil-shub round-9 P1).
  persistRetirementIntent(runId, state, generation);
  const existing = pendingRetirements.get(runId);
  const merged: {
    state: McpOriginatorRetirementState;
    generation?: number;
    createdAtMs: number;
  } = {
    state:
      existing && STATE_RANK[existing.state] > STATE_RANK[state]
        ? existing.state
        : state,
    createdAtMs: existing?.createdAtMs ?? Date.now(),
  };
  const mergedGeneration = generation ?? existing?.generation;
  if (mergedGeneration !== undefined) merged.generation = mergedGeneration;
  pendingRetirements.set(runId, merged);
  scheduleRetirementRetry();
}

/** Test-only: pending retirements, for asserting retry registration. */
export function readPendingMcpOriginatorRetirementsForTests(): ReadonlyMap<
  string,
  {
    state: McpOriginatorRetirementState;
    generation?: number;
    createdAtMs: number;
  }
> {
  return pendingRetirements;
}

function touchRecords(
  records: Map<string, AuthorityRecord>,
  runId: string,
  generation: number | undefined,
  state?: McpOriginatorAuthorityState,
  options?: {
    /**
     * Retry driver only (evil-shub round-9 P1): a FAILED retirement retry
     * must not refresh updatedAtMs — that kept the in-memory record young
     * forever, so pruneExpired never collected it and the in-memory overlay
     * diverged from the disk record a peer could prune. The record's own
     * TTL bounds how long a retirement matters: past it, every token the
     * floor could fence is dead at the server-side 1h ceiling anyway.
     */
    preserveUpdatedAt?: boolean;
  },
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
    // A landed non-live mark is the retirement the intent announced: clear
    // it. While the record stays live the intent survives floor bumps so
    // gates keep failing closed until the mark lands.
    ...(nextState === "live" && existing?.retiringTo !== undefined
      ? { retiringTo: existing.retiringTo }
      : {}),
    updatedAtMs:
      options?.preserveUpdatedAt === true && existing !== undefined
        ? existing.updatedAtMs
        : Date.now(),
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
      // A live record carrying a durable retirement INTENT is not live for
      // admission (evil-shub round-9 P1): the retirement is already
      // announced and will land via retry or outlive the token ceiling, so
      // no delivery may arm authority in the gap.
      if (record.state !== "live" || record.retiringTo !== undefined)
        return { admitted: false, permanent: true };
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
        if (record.state !== "live" || record.retiringTo !== undefined)
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
      // A pending retirement intent withdraws the token too (evil-shub
      // round-9 P1): the run is being retired, so its calls proceed
      // unattributed even before the mark lands.
      if (record.state !== "live" || record.retiringTo !== undefined)
        return { result: false, changed: false };
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
        if (record.state !== "live" || record.retiringTo !== undefined) {
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
  configureAuthorityPersistencePathForTests(path);
}

/** Test-only: shorten the record TTL (null restores the 2h default). */
export function configureMcpOriginatorAuthorityTtlForTests(
  ttlMs: number | null,
): void {
  recordTtlMs = ttlMs ?? AUTHORITY_RECORD_TTL_MS;
}

/** Test-only: drop every record and forget any loaded state. */
export function resetMcpOriginatorAuthority(): void {
  recordsBySuperRunId.clear();
  pendingRetirements.clear();
  recordTtlMs = AUTHORITY_RECORD_TTL_MS;
  if (retirementRetryTimer !== undefined) {
    clearTimeout(retirementRetryTimer);
    retirementRetryTimer = undefined;
  }
}

/** Test-only diagnostics. */
export function readMcpOriginatorAuthorityForTests(runId: string):
  | {
      floor?: number;
      state: McpOriginatorAuthorityState;
      retiringTo?: McpOriginatorRetirementState;
    }
  | undefined {
  const record = authorityTransaction((records) => ({
    result: records.get(runId),
    changed: false,
  }));
  return record
    ? {
        ...(record.floor !== undefined ? { floor: record.floor } : {}),
        state: record.state,
        ...(record.retiringTo !== undefined
          ? { retiringTo: record.retiringTo }
          : {}),
      }
    : undefined;
}
