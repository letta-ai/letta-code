import { open, readFile, stat, unlink } from "node:fs/promises";
import { sleep } from "@/utils/sleep";

export type FileLockOptions = {
  /** A lock file older than this is treated as abandoned and reaped. */
  staleMs?: number;
  /** Poll interval while waiting for a held lock. */
  retryMs?: number;
  /** Give up acquiring the lock after this many ms. */
  timeoutMs?: number;
};

const DEFAULT_OPTIONS: Required<FileLockOptions> = {
  staleMs: 90_000,
  retryMs: 25,
  timeoutMs: 10_000,
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
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const release = await acquireFileLock(lockPath, opts);
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function acquireFileLock(
  lockPath: string,
  opts: Required<FileLockOptions>,
): Promise<() => Promise<void>> {
  const start = Date.now();
  const payload = JSON.stringify({
    pid: process.pid,
    acquiredAt: Date.now(),
  });

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(payload, "utf-8");
        await handle.close();
      } catch (error) {
        try {
          await handle.close();
        } catch {
          // Ignore close failures while cleaning up a failed acquisition.
        }
        try {
          await unlink(lockPath);
        } catch {
          // Best-effort cleanup; another process may have reaped it.
        }
        throw error;
      }
      return async () => {
        try {
          await unlink(lockPath);
        } catch {
          // Already gone (reaped by another process, or unlink raced).
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }

      const reaped = await tryReapStaleLock(lockPath, opts.staleMs);
      if (reaped) {
        continue;
      }

      if (Date.now() - start > opts.timeoutMs) {
        throw new Error(`File lock timeout: ${lockPath}`);
      }
      await sleep(opts.retryMs);
    }
  }
}

async function tryReapStaleLock(
  lockPath: string,
  staleMs: number,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf-8");
  } catch {
    // Lock vanished between EEXIST and read - retry immediately.
    return true;
  }
  let acquiredAt: unknown;
  let isCorrupt = false;
  try {
    acquiredAt = (JSON.parse(raw) as { acquiredAt?: unknown }).acquiredAt;
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
    // `open("wx")` creates the file before `writeFile` fills it. Give a live
    // writer a short grace period before treating corrupt/empty content as an
    // abandoned acquisition.
    if (Date.now() - mtimeMs <= CORRUPT_LOCK_GRACE_MS) {
      return false;
    }
    try {
      await unlink(lockPath);
    } catch {
      // Another reaper got there first.
    }
    return true;
  }
  if (Date.now() - acquiredAt <= staleMs) {
    return false;
  }
  try {
    await unlink(lockPath);
  } catch {
    // Another reaper got there first.
  }
  return true;
}
