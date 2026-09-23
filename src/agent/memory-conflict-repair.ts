import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getMemoryGitDir } from "@/agent/memory-git-dir";
import {
  getOwnProcessStartTime,
  isSameProcessRunning,
  type ProcessIdentity,
} from "@/utils/process-liveness";

const ATTEMPT_FILE = "letta-memory-repair.json";
const OPERATION_HEADS = [
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
];

/**
 * The attempt recorded for a conflict. Every write happens under the
 * checkout lease: the claim runs inside post-turn sync or a worker's sync,
 * and the later transitions inside the repair worker itself.
 */
interface RepairAttempt extends ProcessIdentity {
  signature: string;
  /** "launching" until the repair worker has run; "done" once it has. */
  state: "launching" | "done";
  attemptedAt: string;
}

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

async function attemptPath(memoryDir: string): Promise<string> {
  return join(await getMemoryGitDir(memoryDir), ATTEMPT_FILE);
}

async function readAttempt(path: string): Promise<Partial<RepairAttempt>> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Record that automatic repair is being attempted for the current conflict.
 * Returns false when the same unfinished operation is already being handled:
 * a repair worker has run and could not resolve it (reported to the agent
 * instead of relaunched on every turn), or a repair is still in progress in
 * a running process. An attempt whose process is gone before the worker ran
 * (cancelled, crashed) is retried. A checkout that is not a readable Git
 * repository is left to the worker, which reports the failure itself.
 */
export async function claimMemoryConflictRepair(
  memoryDir: string,
): Promise<boolean> {
  let path: string;
  let signature: string;
  try {
    path = await attemptPath(memoryDir);
    signature = await describeMemoryConflict(
      memoryDir,
      await getMemoryGitDir(memoryDir),
    );
  } catch {
    return true;
  }
  const previous = await readAttempt(path);
  if (previous.signature === signature) {
    if (previous.state === "done") return false;
    if (
      typeof previous.pid === "number" &&
      (await isSameProcessRunning({
        pid: previous.pid,
        ...(typeof previous.started === "string" && {
          started: previous.started,
        }),
      }))
    ) {
      return false;
    }
  }
  const attempt: RepairAttempt = {
    signature,
    state: "launching",
    pid: process.pid,
    ...((await getOwnProcessStartTime()) && {
      started: (await getOwnProcessStartTime()) ?? undefined,
    }),
    attemptedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(attempt));
  return true;
}

/** The repair worker ran; the same conflict is not attempted again automatically. */
export async function completeMemoryConflictRepair(
  memoryDir: string,
): Promise<void> {
  try {
    const path = await attemptPath(memoryDir);
    const attempt = await readAttempt(path);
    if (attempt.signature === undefined) return;
    await writeFile(path, JSON.stringify({ ...attempt, state: "done" }));
  } catch {
    /* Not a repository; nothing was recorded. */
  }
}

/** The attempt never ran (launch failed or was cancelled); let the next turn retry. */
export async function clearMemoryConflictRepair(
  memoryDir: string,
): Promise<void> {
  try {
    await rm(await attemptPath(memoryDir), { force: true });
  } catch {
    /* Not a repository; nothing was recorded. */
  }
}
