import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
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

/** Coordinate workers, sync, and reflection integration across local processes. */
export async function claimMemoryOperation(
  memoryDir: string,
  options: { wait?: boolean; signal?: AbortSignal } = {},
): Promise<(() => Promise<void>) | null> {
  const { stdout } = await promisify(execFile)("git", [
    "-C",
    memoryDir,
    "rev-parse",
    "--git-common-dir",
  ]);
  const path = resolve(memoryDir, stdout.trim(), "letta-memory-operation.json");
  const guard = `${path}.lock`;
  const token = randomUUID();
  const readOwner = async (): Promise<MemoryOwner | null> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as MemoryOwner;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
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

export async function withMemoryOperation<T>(
  memoryDir: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await claimMemoryOperation(memoryDir, { wait: true, signal });
  try {
    signal?.throwIfAborted();
    return await operation();
  } finally {
    await release?.();
  }
}
