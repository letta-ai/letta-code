import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const FILE_LOCK_TIMEOUT_MS = 30_000;
const FILE_LOCK_RETRY_MS = 50;

const inProcessQueues = new Map<string, Promise<unknown>>();
const writerQueues = new Map<string, Promise<unknown>>();

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireExclusiveFileLock(
  lockPath: string,
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  const startedAt = Date.now();

  while (Date.now() - startedAt < FILE_LOCK_TIMEOUT_MS) {
    try {
      await writeFile(lockPath, `${process.pid}\n${Date.now()}\n`, {
        flag: "wx",
      });
      return async () => {
        await unlink(lockPath).catch(() => {});
      };
    } catch {
      if (existsSync(lockPath)) {
        try {
          const contents = await readFile(lockPath, "utf8");
          const pid = Number.parseInt(contents.split("\n")[0] ?? "", 10);
          if (!isPidAlive(pid)) {
            await unlink(lockPath).catch(() => {});
            continue;
          }
        } catch {
          // Retry if the lock file disappeared between exists and read.
        }
      }
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, FILE_LOCK_RETRY_MS),
      );
    }
  }

  throw new Error(`Timed out waiting for memory mutation lock at ${lockPath}`);
}

/**
 * Serialize memory integration for one checkout (in-process queue + file lock).
 * Hold this only around git integration, never across a writer model call.
 */
export async function withMemoryMutationLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(lockDir);
  const previous = inProcessQueues.get(key) ?? Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(async () => {
      const release = await acquireExclusiveFileLock(
        join(key, "memory-mutation.lock"),
      );
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  inProcessQueues.set(key, task);
  try {
    return await task;
  } finally {
    if (inProcessQueues.get(key) === task) {
      inProcessQueues.delete(key);
    }
  }
}

/**
 * One in-process drafting lane per parent agent so two writers do not
 * produce overlapping unintegrated proposals.
 */
export async function enqueueMemoryWriterLane<T>(
  agentId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = agentId.trim();
  const previous = writerQueues.get(key) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(fn);
  writerQueues.set(key, task);
  try {
    return await task;
  } finally {
    if (writerQueues.get(key) === task) {
      writerQueues.delete(key);
    }
  }
}

export function memoryMutationLockDir(memoryDir: string): string {
  return dirname(resolve(memoryDir));
}
