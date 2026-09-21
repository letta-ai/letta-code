import { AsyncLocalStorage } from "node:async_hooks";
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

const MEMORY_OPERATION_ENV = "LETTA_MEMORY_OPERATION";
interface MemoryLease {
  path: string;
  owner: MemoryOwner;
  processes: Promise<unknown>[];
  signal?: AbortSignal;
}
const currentOperation = new AsyncLocalStorage<MemoryLease>();

/** Pass ownership only to children launched inside the operation that holds it. */
export function getMemoryOperationEnv(): NodeJS.ProcessEnv {
  const lease = currentOperation.getStore();
  return {
    [MEMORY_OPERATION_ENV]: lease
      ? JSON.stringify({ path: lease.path, owner: lease.owner })
      : process.env[MEMORY_OPERATION_ENV],
  };
}

/** A yielding shell must finish before its memory checkout can be released. */
export function trackMemoryOperationProcess(
  completion: Promise<unknown>,
  terminate: () => void,
): void {
  const lease = currentOperation.getStore();
  if (!lease) return;
  const signal = lease.signal;
  signal?.addEventListener("abort", terminate, { once: true });
  if (signal?.aborted) terminate();
  lease.processes.push(
    completion
      .catch(() => {})
      .finally(() => {
        signal?.removeEventListener("abort", terminate);
      }),
  );
}

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

/** Lock a checkout and its index; isolated reflection worktrees remain independent. */
export async function getMemoryOperationPath(
  memoryDir: string,
): Promise<string> {
  const { stdout } = await promisify(execFile)("git", [
    "-C",
    memoryDir,
    "rev-parse",
    "--git-dir",
  ]);
  return resolve(
    await realpath(resolve(memoryDir, stdout.trim())),
    "letta-memory-operation.json",
  );
}

/** Coordinate workers, sync, and reflection integration across local processes. */
async function acquireMemoryOperation(
  memoryDir: string,
  options: { wait?: boolean; signal?: AbortSignal } = {},
  inherit = false,
): Promise<{ lease: MemoryLease; release: () => Promise<void> } | null> {
  const path = await getMemoryOperationPath(memoryDir);
  const guard = `${path}.lock`;
  let inherited: Pick<MemoryLease, "path" | "owner"> | undefined;
  if (inherit && process.env[MEMORY_OPERATION_ENV]) {
    try {
      inherited = JSON.parse(process.env[MEMORY_OPERATION_ENV] as string);
    } catch {
      /* Ignore invalid inherited ownership. */
    }
  }
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
      return {
        lease: {
          path,
          owner: { pid: process.pid, token },
          processes: [],
          signal: options.signal,
        },
        release: () =>
          withFileLock(guard, async () => {
            if ((await readOwner())?.token === token) await unlink(path);
          }),
      };
    }
    const owner = await readOwner();
    if (
      inherited?.path === path &&
      owner &&
      isAlive(owner.pid) &&
      owner.pid === inherited.owner?.pid &&
      owner.token === inherited.owner?.token
    ) {
      return {
        lease: { path, owner, processes: [], signal: options.signal },
        release: async () => {},
      };
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
  return (await acquireMemoryOperation(memoryDir, options))?.release ?? null;
}

export async function withMemoryOperation<T>(
  memoryDir: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const acquired = await acquireMemoryOperation(
    memoryDir,
    { wait: true, signal },
    true,
  );
  if (!acquired) throw new Error("Failed to acquire memory checkout");
  return currentOperation.run(acquired.lease, async () => {
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      await Promise.all(acquired.lease.processes);
      await acquired.release();
    }
  });
}
