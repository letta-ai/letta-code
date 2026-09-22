import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getMemoryGitDir } from "@/agent/memory-git-dir";
import { claimMemoryOperation } from "@/agent/memory-operation";

const ATTEMPT_FILE = "letta-memory-repair.json";
const OPERATION_HEADS = [
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
];

async function readOptional(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

/** Identify the unfinished Git operation: HEAD plus whatever it is merging in. */
async function describeMemoryConflict(
  memoryDir: string,
  gitDir: string,
): Promise<string> {
  let head = "";
  try {
    const { stdout } = await promisify(execFile)("git", [
      "-C",
      memoryDir,
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    head = stdout.trim();
  } catch {
    /* Unborn branch. */
  }
  const heads = await Promise.all(
    OPERATION_HEADS.map((name) => readOptional(join(gitDir, name))),
  );
  return [head, ...heads].join("\n");
}

/**
 * Record that automatic repair is being attempted for the current conflict.
 * Returns null when the same unfinished operation was already handed to a
 * repair worker, so a conflict the worker could not resolve is reported to the
 * agent instead of launching another worker on every turn. Otherwise returns
 * a release that forgets this attempt (a launch that failed or was cancelled
 * before running has not tried the conflict); the release only removes its
 * own record, never a newer attempt recorded by another process. A checkout
 * that is not a readable Git repository is left to the worker, which reports
 * the failure itself.
 */
export type ReleaseMemoryConflictRepair = (options?: {
  /** The caller already holds the checkout lease (launch paths do). */
  leaseHeld?: boolean;
}) => Promise<void>;

export async function claimMemoryConflictRepair(
  memoryDir: string,
): Promise<ReleaseMemoryConflictRepair | null> {
  let gitDir: string;
  try {
    gitDir = await getMemoryGitDir(memoryDir);
  } catch {
    return async () => undefined;
  }
  const path = join(gitDir, ATTEMPT_FILE);
  const signature = await describeMemoryConflict(memoryDir, gitDir);
  const readAttempt = async (): Promise<{
    signature?: string;
    nonce?: string;
  }> => {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      return {};
    }
  };
  if ((await readAttempt()).signature === signature) return null;
  const nonce = randomUUID();
  await writeFile(
    path,
    JSON.stringify({ signature, nonce, attemptedAt: new Date().toISOString() }),
  );
  return async (options = {}) => {
    // Compare-and-remove must not race a newer attempt from another process;
    // attempts are written under the checkout lease, so remove under it too.
    // At exit the lease may be busy: then leave the marker, which costs one
    // "already attempted" report instead of a retry.
    const lease = options.leaseHeld
      ? null
      : await claimMemoryOperation(memoryDir);
    if (!options.leaseHeld && !lease) return;
    try {
      if ((await readAttempt()).nonce === nonce)
        await rm(path, { force: true });
    } finally {
      await lease?.();
    }
  };
}
