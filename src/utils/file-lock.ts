import { randomUUID } from "node:crypto";
import { link, readFile, stat, unlink, writeFile } from "node:fs/promises";
import {
  getOwnProcessStartTime,
  isSameProcessRunning,
} from "@/utils/process-liveness";
import { sleep } from "@/utils/sleep";

export type FileLockOptions = {
  staleMs?: number;
  retryMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
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
    } catch {}
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
      return true;
    }
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
    return true;
  } finally {
    await marker();
  }
}

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
      } catch {}
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
  } catch {}
  const alive =
    typeof owner.pid === "number" &&
    (await isSameProcessRunning({
      pid: owner.pid,
      ...(typeof owner.started === "string" && { started: owner.started }),
    }));
  if (alive) return null;
  try {
    if ((await readFile(reapPath, "utf-8")) === raw) await unlink(reapPath);
  } catch {}
  return null;
}
