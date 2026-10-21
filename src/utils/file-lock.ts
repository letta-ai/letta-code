import { randomUUID } from "node:crypto";
import { link, readFile, stat, unlink, writeFile } from "node:fs/promises";
import {
  getOwnProcessStartTime,
  isSameProcessRunning,
} from "@/utils/process-liveness";
import { sleep } from "@/utils/sleep";

export type FileLockOptions = {
  /** A lock file older than this is treated as abandoned and reaped. */
  staleMs?: number;
  /** Poll interval while waiting for a held lock. */
  retryMs?: number;
  /** Give up acquiring the lock after this many ms; 0 tries once, Infinity waits. */
  timeoutMs?: number;
  /** Stop waiting when aborted. */
  signal?: AbortSignal;
  /**
   * Reap a lock only when the process that wrote it is gone, never merely
   * because it is old. A paused or slow holder then keeps the lock and
   * waiters time out, which is the safe outcome for a critical section that
   * must stay exclusive; age-based reaping can let two holders in.
   */
  reapOnlyDeadOwner?: boolean;
};

type ResolvedOptions = Required<Omit<FileLockOptions, "signal">> &
  Pick<FileLockOptions, "signal">;

const DEFAULT_OPTIONS: ResolvedOptions = {
  staleMs: 90_000,
  retryMs: 25,
  timeoutMs: 10_000,
  reapOnlyDeadOwner: false,
};

const CORRUPT_LOCK_GRACE_MS = 100;

/**
 * Cross-process critical section guarded by an O_EXCL lock file. The lock
 * file path is created by the caller (its parent directory must already
 * exist). Stale locks (older than `staleMs`) are reaped automatically so a
 * crashed holder cannot block the system indefinitely.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const release = await tryAcquireFileLock(lockPath, options);
  if (!release) throw new Error(`File lock timeout: ${lockPath}`);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Acquire the lock and return its release, or null once `timeoutMs` elapses.
 * The record is written in full to a private file and published with a hard
 * link, so a lock file is never seen half-written and a process paused
 * across a reap cannot overwrite a lock someone else has since taken.
 * Release removes the file only while it still holds this acquisition.
 */
export async function tryAcquireFileLock(
  lockPath: string,
  options?: FileLockOptions,
): Promise<(() => Promise<void>) | null> {
  const opts: ResolvedOptions = { ...DEFAULT_OPTIONS, ...options };
  const start = Date.now();
  const payload = await ownerRecord();

  while (true) {
    opts.signal?.throwIfAborted();
    if (await publishExclusive(lockPath, payload)) {
      return () => releaseIfHeld(lockPath, payload, opts);
    }
    if (await tryReapStaleLock(lockPath, opts)) continue;
    if (Date.now() - start >= opts.timeoutMs) return null;
    await sleep(opts.retryMs);
  }
}

async function ownerRecord(): Promise<string> {
  return JSON.stringify({
    pid: process.pid,
    started: await getOwnProcessStartTime(),
    acquiredAt: Date.now(),
    token: randomUUID(),
  });
}

/**
 * Create `path` holding `payload` only if it does not exist. The record is
 * written to a private file and published with a hard link, so it is never
 * seen half-written and cannot overwrite a file that appeared meanwhile.
 */
async function publishExclusive(
  path: string,
  payload: string,
): Promise<boolean> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, payload, "utf-8");
  try {
    await link(temporaryPath, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    return false;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

/**
 * Remove the lock only while it still holds this acquisition. Under
 * age-based reaping a live holder can be reaped and replaced at any moment,
 * so the check and the unlink run under the reap marker, serialized with
 * reapers; a holder that is never reaped alive (`reapOnlyDeadOwner`) needs
 * no marker.
 */
async function releaseIfHeld(
  lockPath: string,
  payload: string,
  opts: ResolvedOptions,
): Promise<void> {
  const remove = async () => {
    try {
      if ((await readFile(lockPath, "utf-8")) === payload) {
        await unlink(lockPath);
      }
    } catch {
      // Already gone (reaped by another process, or unlink raced).
    }
  };
  if (opts.reapOnlyDeadOwner) return remove();
  for (;;) {
    const marker = await acquireReapMarker(lockPath);
    if (marker) {
      try {
        return await remove();
      } finally {
        await marker();
      }
    }
    await sleep(opts.retryMs);
  }
}

async function tryReapStaleLock(
  lockPath: string,
  opts: ResolvedOptions,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf-8");
  } catch {
    // Lock vanished between EEXIST and read - retry immediately.
    return true;
  }
  let acquiredAt: unknown;
  let owner: { pid?: unknown; started?: unknown } = {};
  let isCorrupt = false;
  try {
    owner = JSON.parse(raw) as { pid?: unknown; started?: unknown };
    acquiredAt = (owner as { acquiredAt?: unknown }).acquiredAt;
  } catch {
    isCorrupt = true;
  }
  if (isCorrupt || typeof acquiredAt !== "number") {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(lockPath)).mtimeMs;
    } catch {
      // Lock vanished between read and stat - retry immediately.
      return true;
    }
    // An older writer may still create the file before filling it. Give a
    // live writer a short grace period before treating corrupt/empty content
    // as an abandoned acquisition.
    if (Date.now() - mtimeMs <= CORRUPT_LOCK_GRACE_MS) {
      return false;
    }
    return removeIfUnchanged(lockPath, raw);
  }
  if (opts.reapOnlyDeadOwner) {
    if (typeof owner.pid !== "number") return false;
    const running = await isSameProcessRunning({
      pid: owner.pid,
      ...(typeof owner.started === "string" && { started: owner.started }),
    });
    if (running) return false;
  } else if (Date.now() - acquiredAt <= opts.staleMs) {
    return false;
  }
  return removeIfUnchanged(lockPath, raw);
}

/**
 * Remove a lock file only if it still holds the stale content the caller
 * judged, and only while holding the exclusive reap marker. Two contenders
 * that both judged the old lock dead therefore cannot have the second one
 * delete the fresh lock the first just acquired.
 */
async function removeIfUnchanged(
  lockPath: string,
  expected: string,
): Promise<boolean> {
  const marker = await acquireReapMarker(lockPath);
  if (!marker) return false;
  try {
    let current: string;
    try {
      current = await readFile(lockPath, "utf-8");
    } catch {
      return true;
    }
    if (current !== expected) return false;
    await unlink(lockPath);
    return true;
  } catch {
    // Another reaper got there first.
    return true;
  } finally {
    await marker();
  }
}

/**
 * The reap marker serializes everyone who may delete `lockPath`. It is
 * published atomically, so it is never seen empty, and it is cleared only
 * when the reaper that wrote it is gone. A marker left by a crashed reaper is
 * removed with a content check; that removal is the one step here without
 * its own marker, and it can only race after a reaper crash.
 */
async function acquireReapMarker(
  lockPath: string,
): Promise<(() => Promise<void>) | null> {
  const reapPath = `${lockPath}.reap`;
  const payload = await ownerRecord();
  if (await publishExclusive(reapPath, payload)) {
    return async () => {
      try {
        if ((await readFile(reapPath, "utf-8")) === payload) {
          await unlink(reapPath);
        }
      } catch {
        // Already gone.
      }
    };
  }
  let raw: string;
  try {
    raw = await readFile(reapPath, "utf-8");
  } catch {
    return null;
  }
  let owner: { pid?: unknown; started?: unknown } = {};
  try {
    owner = JSON.parse(raw) as { pid?: unknown; started?: unknown };
  } catch {
    // Not one of ours; leave it to the corrupt-lock path on the next attempt.
  }
  const alive =
    typeof owner.pid === "number" &&
    (await isSameProcessRunning({
      pid: owner.pid,
      ...(typeof owner.started === "string" && { started: owner.started }),
    }));
  if (alive) return null;
  try {
    if ((await readFile(reapPath, "utf-8")) === raw) await unlink(reapPath);
  } catch {
    // Another contender cleared it.
  }
  return null;
}
