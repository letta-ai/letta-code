import { resolve } from "node:path";
import { getMemoryGitDir } from "@/agent/memory-git-dir";
import { type FileLockOptions, tryAcquireFileLock } from "@/utils/file-lock";

export async function getMemoryOperationPath(
  memoryDir: string,
): Promise<string> {
  return resolve(
    await getMemoryGitDir(memoryDir),
    "letta-memory-operation.lock",
  );
}

const LEASE_OPTIONS: FileLockOptions = {
  reapOnlyDeadOwner: true,
  retryMs: 100,
};

export async function claimMemoryOperation(
  memoryDir: string,
  options: { wait?: boolean; signal?: AbortSignal } = {},
): Promise<(() => Promise<void>) | null> {
  return tryAcquireFileLock(await getMemoryOperationPath(memoryDir), {
    ...LEASE_OPTIONS,
    timeoutMs: options.wait ? Number.POSITIVE_INFINITY : 0,
    signal: options.signal,
  });
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
