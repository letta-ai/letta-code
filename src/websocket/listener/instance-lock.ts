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
 * conclude "unlocked". Stale locks from dead pids are reclaimed; liveness
 * verification failures are treated as "held" (fail safe — never assume a
 * process is gone because we could not check).
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
}

export type ClaimListenerLockResult =
  | { kind: "acquired"; lockPath: string }
  | { kind: "held"; holder: ListenerLockRecord }
  | { kind: "unavailable"; reason: string };

let activeLockPath: string | null = null;

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only proof the process is gone. Permission errors and
    // unfamiliar platform errors fail safe: treat as alive.
    return !hasErrorCode(error, "ESRCH");
  }
}

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
    };
  } catch {
    return null;
  }
}

/**
 * Atomically publish an initialized lock file: write a unique candidate,
 * hard-link it to the lock path (fails EEXIST if held), remove candidate.
 */
async function publishLock(
  lockPath: string,
  record: ListenerLockRecord,
): Promise<"ok" | "exists" | "error"> {
  const candidatePath = path.join(
    path.dirname(lockPath),
    `.candidate-${randomUUID()}`,
  );
  try {
    await writeFile(candidatePath, JSON.stringify(record), { flag: "wx" });
    await link(candidatePath, lockPath);
    return "ok";
  } catch (error) {
    return hasErrorCode(error, "EEXIST") ? "exists" : "error";
  } finally {
    await rm(candidatePath, { force: true }).catch(() => {});
  }
}

/**
 * Try to claim the single-run lock for a listener instance.
 *
 * - "acquired": this session owns the instance; release on shutdown.
 * - "held": the exact same listener is already running — the caller must
 *   fail visibly (print holder pid) and exit. Nothing is killed.
 * - "unavailable": the lock state could not be established (fs errors).
 *   Callers proceed WITHOUT the lock (advisory guard; a broken lock dir
 *   must not brick listener startup) but should log the reason.
 */
export async function claimListenerLock(
  listenerInstanceId: string,
  lockDir: string = LOCK_DIR,
): Promise<ClaimListenerLockResult> {
  const lockPath = getListenerLockPath(listenerInstanceId, lockDir);
  const record: ListenerLockRecord = {
    pid: process.pid,
    listenerInstanceId,
    acquiredAt: Date.now(),
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

  for (let attempt = 0; attempt < 2; attempt++) {
    const published = await publishLock(lockPath, record);
    if (published === "ok") {
      activeLockPath = lockPath;
      return { kind: "acquired", lockPath };
    }
    if (published === "error") {
      return { kind: "unavailable", reason: "lock file write failed" };
    }

    // Held: read the holder and decide stale vs live.
    let raw: string;
    try {
      raw = await readFile(lockPath, "utf-8");
    } catch {
      // Vanished between EEXIST and read — retry the claim once.
      continue;
    }
    const holder = parseLockRecord(raw);
    if (holder && isPidAlive(holder.pid)) {
      // Any live holder means "held" — including our own pid: a restarted
      // process always has a new pid, so a same-pid holder is either this
      // process double-starting the same listener (must fail visibly) or a
      // concurrent claim that already won.
      return { kind: "held", holder };
    }
    // Dead pid or corrupt record: reclaim by removing and retrying the
    // atomic publish. The remove-then-publish window is closed by the
    // second publish attempt failing EEXIST if someone else won it.
    try {
      await rm(lockPath, { force: true });
    } catch {
      // Another reclaimer got there first — loop and re-attempt.
    }
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
