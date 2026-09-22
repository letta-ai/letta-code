import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { withFileLock } from "@/utils/file-lock";
import { sleep } from "@/utils/sleep";

interface MemoryOwner {
  pid: number;
  token: string;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Harness state lives in the checkout's own Git directory, so worktrees stay independent. */
export async function getMemoryGitDir(memoryDir: string): Promise<string> {
  const { stdout } = await promisify(execFile)("git", [
    "-C",
    memoryDir,
    "rev-parse",
    "--git-dir",
  ]);
  return realpath(resolve(memoryDir, stdout.trim()));
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
 */
async function acquireMemoryOperation(
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
        ? { pid: owner.pid, token: owner.token }
        : null;
    } catch {
      // An unreadable owner file must not wedge every memory operation.
      return null;
    }
  };
  for (;;) {
    options.signal?.throwIfAborted();
    const acquired = await withFileLock(guard, async () => {
      const owner = await readOwner();
      if (owner && isAlive(owner.pid)) return false;
      const temporaryPath = `${path}.${token}.tmp`;
      await writeFile(
        temporaryPath,
        JSON.stringify({ pid: process.pid, token }),
      );
      await rename(temporaryPath, path);
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

/** Reserve the checkout without transferring ownership to unrelated concurrent calls. */
export async function claimMemoryOperation(
  memoryDir: string,
  options: { wait?: boolean; signal?: AbortSignal } = {},
): Promise<(() => Promise<void>) | null> {
  return acquireMemoryOperation(memoryDir, options);
}

export async function withMemoryOperation<T>(
  memoryDir: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await acquireMemoryOperation(memoryDir, {
    wait: true,
    signal,
  });
  if (!release) throw new Error("Failed to acquire memory checkout");
  try {
    signal?.throwIfAborted();
    return await operation();
  } finally {
    await release();
  }
}
