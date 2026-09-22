import { randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getMemoryGitDir } from "@/agent/memory-git-dir";
import { withFileLock } from "@/utils/file-lock";
import {
  getProcessStartTime,
  isSameProcessRunning,
  type ProcessIdentity,
} from "@/utils/process-liveness";
import { sleep } from "@/utils/sleep";

interface MemoryOwner extends ProcessIdentity {
  token: string;
}

/** Lock a checkout and its index; isolated reflection worktrees remain independent. */
export async function getMemoryOperationPath(
  memoryDir: string,
): Promise<string> {
  return resolve(
    await getMemoryGitDir(memoryDir),
    "letta-memory-operation.json",
  );
}

/**
 * Serialize the harness-owned writers of a memory checkout across local
 * processes: memory workers, conflict repair, reflection integration, and
 * post-turn sync. The primary agent's own edits are not routed through this
 * lock; the prompts ask it to wait for a worker it launched, and workers stage
 * only the files they change so concurrent edits degrade to a Git conflict.
 *
 * Returns a release function, or null when the checkout is owned by another
 * running process and `wait` is false. With `wait`, polls until the owner
 * releases or exits; a holder that is merely paused keeps the lease, and only
 * the abort signal gives up.
 */
export async function claimMemoryOperation(
  memoryDir: string,
  options: { wait?: boolean; signal?: AbortSignal } = {},
): Promise<(() => Promise<void>) | null> {
  const path = await getMemoryOperationPath(memoryDir);
  const guard = `${path}.lock`;
  const token = randomUUID();
  const readOwner = async (): Promise<MemoryOwner | null> => {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const owner = JSON.parse(content) as Partial<MemoryOwner> | null;
      return typeof owner?.pid === "number" && typeof owner.token === "string"
        ? {
            pid: owner.pid,
            token: owner.token,
            ...(typeof owner.started === "string" && {
              started: owner.started,
            }),
          }
        : null;
    } catch {
      // An unreadable owner file must not wedge every memory operation.
      return null;
    }
  };
  const started = await getProcessStartTime(process.pid);
  for (;;) {
    options.signal?.throwIfAborted();
    const acquired = await withFileLock(guard, async () => {
      const owner = await readOwner();
      if (owner && (await isSameProcessRunning(owner))) return false;
      // Dead, unreadable or absent owner: clear it before publishing ours.
      await unlink(path).catch(() => undefined);
      // Write the record in full to a private file, then publish it with a
      // hard link: the link is atomic, never exposes partial content, and fails
      // with EEXIST if this process was paused across a guard reap and another
      // acquirer published first, so we lose rather than overwrite them.
      const temporaryPath = `${path}.${token}.tmp`;
      await writeFile(
        temporaryPath,
        JSON.stringify({
          pid: process.pid,
          token,
          ...(started && { started }),
        }),
      );
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return false;
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
      return true;
    });
    if (acquired) {
      return () =>
        withFileLock(guard, async () => {
          if ((await readOwner())?.token === token) await unlink(path);
        });
    }
    if (!options.wait) return null;
    await sleep(100);
  }
}

export async function withMemoryOperation<T>(
  memoryDir: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await claimMemoryOperation(memoryDir, { wait: true, signal });
  if (!release) throw new Error("Failed to acquire memory checkout");
  try {
    signal?.throwIfAborted();
    return await operation();
  } finally {
    await release();
  }
}
