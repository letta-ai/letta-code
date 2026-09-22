import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getMemoryGitDir } from "@/agent/memory-git-dir";

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
 * Returns false when the same unfinished operation was already handed to a
 * repair worker, so a conflict the worker could not resolve is reported to the
 * agent instead of launching another worker on every turn. A checkout that is
 * not a readable Git repository is left to the worker, which reports the
 * failure itself.
 */
export async function claimMemoryConflictRepair(
  memoryDir: string,
): Promise<boolean> {
  let gitDir: string;
  try {
    gitDir = await getMemoryGitDir(memoryDir);
  } catch {
    return true;
  }
  const path = join(gitDir, ATTEMPT_FILE);
  const signature = await describeMemoryConflict(memoryDir, gitDir);
  let previous: string | undefined;
  try {
    previous = (
      JSON.parse(await readFile(path, "utf8")) as { signature?: string }
    ).signature;
  } catch {
    /* No usable earlier attempt. */
  }
  if (previous === signature) return false;
  await writeFile(
    path,
    JSON.stringify({ signature, attemptedAt: new Date().toISOString() }),
  );
  return true;
}

/** Forget an attempt whose worker was cancelled before it could report. */
export async function releaseMemoryConflictRepair(
  memoryDir: string,
): Promise<void> {
  try {
    await rm(join(await getMemoryGitDir(memoryDir), ATTEMPT_FILE), {
      force: true,
    });
  } catch {
    /* Not a repository; nothing was recorded. */
  }
}
