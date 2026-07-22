/**
 * Atomic local lock, keyed by explicit listener instance id (LET-10085).
 *
 * Guards exactly one thing: the SAME configured listener must not run
 * twice on one host. Different instance ids never contend — coexistence is
 * the default (Desktop slots, other manual listeners, other projects).
 *
 * Policy is FAIL VISIBLY: if the exact listener is already running, the
 * newcomer reports it and exits. This lock never terminates anything — a
 * lock is not an ownership registry, and killing based on lock contents is
 * how #3449 nearly shot healthy siblings. Spawner-owned children are
 * reaped by their spawner's registry (LET-10023), not here.
 *
 * Acquisition is atomic via O_EXCL create + hard-link publication (the
 * same CAS shape as remote-settings-lock.ts): the lock file appears fully
 * initialized or not at all, so two simultaneous starters cannot both
 * conclude "unlocked".
 *
 * Stale-lock recovery uses a RECLAIM CLAIM (the reference protocol's
 * guard): before removing a dead holder's lock file, a claimant must
 * atomically publish a claim keyed to that exact stale record, then
 * re-verify the lock file still contains it. Without the claim, two
 * racers that both observed the stale record could interleave as
 * A-removes/A-publishes-fresh/B-removes-A's-FRESH-lock — the TOCTOU this
 * closes. A crashed reclaimer degrades to "unavailable" (advisory), never
 * to a false acquisition.
 */

import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const LOCK_DIR = path.join(homedir(), ".letta", "listener-locks");

export interface ListenerLockRecord {
  pid: number;
  listenerInstanceId: string;
  acquiredAt: number;
  /** Random per-acquisition nonce: distinguishes lock generations even for one pid. */
  lockNonce: string;
}

export type ClaimListenerLockResult =
  | { kind: "acquired"; lockPath: string }
  | { kind: "held"; holder: ListenerLockRecord }
  | { kind: "unavailable"; reason: string };

export interface ListenerLockDeps {
  isPidAlive: (pid: number) => boolean;
}

let activeLockPath: string | null = null;

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only proof the process is gone. Permission errors and
    // unfamiliar platform errors fail safe: treat as alive.
    return !hasErrorCode(error, "ESRCH");
  }
}

const DEFAULT_DEPS: ListenerLockDeps = { isPidAlive: defaultIsPidAlive };

export function getListenerLockPath(
  listenerInstanceId: string,
  lockDir: string = LOCK_DIR,
): string {
  const digest = createHash("sha256")
    .update(listenerInstanceId)
    .digest("hex")
    .slice(0, 20);
  return path.join(lockDir, `${digest}.lock`);
}

function parseLockRecord(raw: string): ListenerLockRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ListenerLockRecord>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.listenerInstanceId !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      listenerInstanceId: parsed.listenerInstanceId,
      acquiredAt: typeof parsed.acquiredAt === "number" ? parsed.acquiredAt : 0,
      lockNonce: typeof parsed.lockNonce === "string" ? parsed.lockNonce : "",
    };
  } catch {
    return null;
  }
}

/**
 * Atomically publish a fully-initialized file: write a unique candidate,
 * hard-link it to the target (fails EEXIST when the target exists), remove
 * the candidate.
 */
async function publishFile(
  targetPath: string,
  contents: string,
): Promise<"ok" | "exists" | "error"> {
  const candidatePath = path.join(
    path.dirname(targetPath),
    `.candidate-${randomUUID()}`,
  );
  try {
    await writeFile(candidatePath, contents, { flag: "wx" });
    await link(candidatePath, targetPath);
    return "ok";
  } catch (error) {
    return hasErrorCode(error, "EEXIST") ? "exists" : "error";
  } finally {
    await rm(candidatePath, { force: true }).catch(() => {});
  }
}

/**
 * Remove a stale lock under a reclaim claim keyed to the exact stale
 * content. Returns:
 * - "reclaimed": the stale lock was removed by us; caller may re-attempt
 *   the publish.
 * - "changed": the lock no longer contains the stale record (someone else
 *   already reclaimed and/or republished); caller must re-evaluate.
 * - "contended"/"unavailable": another claimant owns the reclaim, or the
 *   claim state cannot be established safely.
 */
async function reclaimStaleLock(
  lockPath: string,
  staleRaw: string,
  deps: ListenerLockDeps,
): Promise<"reclaimed" | "changed" | "contended" | "unavailable"> {
  const claimPath = `${lockPath}.reclaim-${createHash("sha256")
    .update(staleRaw)
    .digest("hex")
    .slice(0, 16)}`;
  const published = await publishFile(
    claimPath,
    JSON.stringify({ pid: process.pid }),
  );
  if (published === "exists") {
    let claimOwnerPid: number | null = null;
    try {
      const parsed = JSON.parse(await readFile(claimPath, "utf-8")) as {
        pid?: unknown;
      };
      claimOwnerPid = typeof parsed.pid === "number" ? parsed.pid : null;
    } catch {
      return "unavailable";
    }
    if (claimOwnerPid !== null && deps.isPidAlive(claimOwnerPid)) {
      // A live claimant is mid-reclaim; it will publish a fresh lock.
      return "contended";
    }
    // Crashed reclaimer. Taking over its claim safely needs the reference
    // protocol's depth chain; for an advisory single-run guard, degrade
    // instead of risking a double-remove.
    return "unavailable";
  }
  if (published === "error") {
    return "unavailable";
  }

  try {
    // We own the claim for THIS stale generation. Only remove the lock if
    // it still contains exactly that generation — a fresh lock published
    // meanwhile stays untouched.
    let currentRaw: string;
    try {
      currentRaw = await readFile(lockPath, "utf-8");
    } catch {
      return "changed";
    }
    if (currentRaw !== staleRaw) {
      return "changed";
    }
    await rm(lockPath, { force: true });
    return "reclaimed";
  } catch {
    return "unavailable";
  } finally {
    await rm(claimPath, { force: true }).catch(() => {});
  }
}

/**
 * Try to claim the single-run lock for a listener instance.
 *
 * - "acquired": this session owns the instance; release on shutdown.
 * - "held": the exact same listener is already running — the caller must
 *   fail visibly (print holder pid) and exit. Nothing is killed.
 * - "unavailable": the lock state could not be established (fs errors,
 *   crashed reclaimer). Callers proceed WITHOUT the lock (advisory guard;
 *   a broken lock dir must not brick listener startup) but should log.
 */
export async function claimListenerLock(
  listenerInstanceId: string,
  lockDir: string = LOCK_DIR,
  deps: Partial<ListenerLockDeps> = {},
): Promise<ClaimListenerLockResult> {
  const resolvedDeps: ListenerLockDeps = { ...DEFAULT_DEPS, ...deps };
  const lockPath = getListenerLockPath(listenerInstanceId, lockDir);
  const record: ListenerLockRecord = {
    pid: process.pid,
    listenerInstanceId,
    acquiredAt: Date.now(),
    lockNonce: randomUUID(),
  };

  try {
    await mkdir(lockDir, { recursive: true });
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `cannot create lock directory: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const published = await publishFile(lockPath, JSON.stringify(record));
    if (published === "ok") {
      activeLockPath = lockPath;
      return { kind: "acquired", lockPath };
    }
    if (published === "error") {
      return { kind: "unavailable", reason: "lock file write failed" };
    }

    // Held: read the holder and decide live vs stale.
    let raw: string;
    try {
      raw = await readFile(lockPath, "utf-8");
    } catch {
      // Vanished between EEXIST and read — retry the publish.
      continue;
    }
    const holder = parseLockRecord(raw);
    if (holder && resolvedDeps.isPidAlive(holder.pid)) {
      // Any live holder means "held" — including our own pid: a restarted
      // process always has a new pid, so a same-pid holder is this process
      // double-starting the same listener (must fail visibly).
      return { kind: "held", holder };
    }

    // Dead pid or corrupt record: reclaim under a content-keyed claim so a
    // concurrent claimant can never remove OUR freshly published lock.
    const reclaim = await reclaimStaleLock(lockPath, raw, resolvedDeps);
    if (reclaim === "contended") {
      // A live claimant is republishing; on re-attempt we will observe its
      // fresh lock and report "held".
      continue;
    }
    if (reclaim === "unavailable") {
      return {
        kind: "unavailable",
        reason: "stale lock reclaim could not be completed safely",
      };
    }
    // "reclaimed" or "changed": loop to re-attempt the atomic publish /
    // re-evaluate the current holder.
  }

  return { kind: "unavailable", reason: "lock contention did not settle" };
}

/**
 * Release the lock if this session acquired it. Only removes the file when
 * it still names this process — a slower shutdown must not delete a newer
 * claimant's lock.
 */
export async function releaseListenerLock(): Promise<void> {
  const lockPath = activeLockPath;
  activeLockPath = null;
  if (!lockPath) {
    return;
  }
  try {
    const holder = parseLockRecord(await readFile(lockPath, "utf-8"));
    if (holder?.pid === process.pid) {
      await rm(lockPath, { force: true });
    }
  } catch {
    // Already gone or unreadable — nothing to release.
  }
}

/** Test-only: reset module state. */
export function __resetListenerLockForTests(): void {
  activeLockPath = null;
}
