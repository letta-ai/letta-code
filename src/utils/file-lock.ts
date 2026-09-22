import { randomUUID } from "node:crypto";
import {
  link,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
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
  const payload = JSON.stringify({
    pid: process.pid,
    started: await getOwnProcessStartTime(),
    acquiredAt: Date.now(),
    token: randomUUID(),
  });
  const temporaryPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;

  while (true) {
    opts.signal?.throwIfAborted();
    await writeFile(temporaryPath, payload, "utf-8");
    let acquired = false;
    try {
      await link(temporaryPath, lockPath);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    if (acquired) {
      return async () => {
        try {
          if ((await readFile(lockPath, "utf-8")) === payload) {
            await unlink(lockPath);
          }
        } catch {
          // Already gone (reaped by another process, or unlink raced).
        }
      };
    }

    if (await tryReapStaleLock(lockPath, opts)) continue;
    if (Date.now() - start >= opts.timeoutMs) return null;
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
    return removeIfUnchanged(lockPath, raw, opts);
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
  return removeIfUnchanged(lockPath, raw, opts);
}

/**
 * Remove a lock file only if it still holds the stale content the caller
 * judged, and only while holding an exclusive reap marker. Two contenders
 * that both judged the old lock dead therefore cannot have the second one
 * delete the fresh lock the first just acquired.
 */
async function removeIfUnchanged(
  lockPath: string,
  expected: string,
  opts: ResolvedOptions,
): Promise<boolean> {
  const reapPath = `${lockPath}.reap`;
  let marker: Awaited<ReturnType<typeof open>>;
  try {
    marker = await open(reapPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    // Another reaper is active. If it died mid-reap its marker is itself a
    // stale lock; clear it the same way, then let the caller retry.
    await tryReapStaleLock(reapPath, { ...opts, reapOnlyDeadOwner: true });
    return false;
  }
  try {
    await marker.writeFile(
      JSON.stringify({
        pid: process.pid,
        started: await getOwnProcessStartTime(),
        acquiredAt: Date.now(),
      }),
      "utf-8",
    );
    await marker.close();
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
    await unlink(reapPath).catch(() => undefined);
  }
}
