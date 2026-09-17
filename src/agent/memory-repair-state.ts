import { existsSync } from "node:fs";
import { join } from "node:path";
import { getMemoryGitDir } from "@/agent/memory-git";
import { withFileLock } from "@/utils/file-lock";
import { readJsonFile, writeJsonFile } from "@/utils/fs";

const RETRY_DELAY_MS = 5 * 60_000;

interface MemoryRepairState {
  pid: number | null;
  retryAfter: number;
}

async function readState(path: string): Promise<MemoryRepairState> {
  try {
    return await readJsonFile<MemoryRepairState>(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { pid: null, retryAfter: 0 };
  }
}

function isActive(state: MemoryRepairState): boolean {
  if (!state.pid || !Number.isInteger(state.pid) || state.pid <= 0)
    return false;
  try {
    process.kill(state.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function statePath(memoryDir: string): Promise<string> {
  return join(await getMemoryGitDir(memoryDir), "letta-memory-repair.json");
}

export async function isMemoryRepairActive(
  memoryDir: string,
): Promise<boolean> {
  if (!existsSync(join(memoryDir, ".git"))) return false;
  const path = await statePath(memoryDir);
  return withFileLock(`${path}.lock`, async () =>
    isActive(await readState(path)),
  );
}

/** Only the claim owner launches a repair; other CLI/listener processes defer. */
export async function claimMemoryRepair(
  memoryDir: string,
): Promise<((resolved: boolean) => Promise<void>) | null> {
  const path = await statePath(memoryDir);
  const claimed = await withFileLock(`${path}.lock`, async () => {
    const state = await readState(path);
    if (isActive(state) || state.retryAfter > Date.now()) return false;
    await writeJsonFile(path, { pid: process.pid, retryAfter: 0 });
    return true;
  });
  if (!claimed) return null;
  return async (resolved) => {
    await withFileLock(`${path}.lock`, async () => {
      await writeJsonFile(path, {
        pid: null,
        retryAfter: resolved ? 0 : Date.now() + RETRY_DELAY_MS,
      });
    });
  };
}
