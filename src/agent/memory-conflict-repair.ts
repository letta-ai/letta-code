import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
 * The attempt recorded for a conflict. It is claimed under the checkout
 * lease, inside post-turn sync or a worker's sync, and advanced or forgotten
 * by the repair worker launched for it. Every later transition names the
 * attempt's token, so a worker that fails or is cancelled late can only
 * touch its own record, never one a newer claim has written since.
 */
interface RepairAttempt extends ProcessIdentity {
  signature: string;
  token: string;
  /** "launching" until the repair worker has run; "done" once it has. */
  state: "launching" | "done";
  attemptedAt: string;
}

export type MemoryConflictRepairClaim =
  /** Recorded; the caller launches a worker that carries `token`. */
  | { status: "claimed"; token: string }
  /** A running process is still repairing this conflict. */
  | { status: "in_progress" }
  /** A worker has run on this conflict and could not resolve it. */
  | { status: "attempted" };

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
 * Record that automatic repair is being attempted for the current conflict,
 * unless the same unfinished operation is already handled: a repair worker
 * has run and could not resolve it (reported to the agent instead of
 * relaunched every turn), or a repair is still in progress in a running
 * process. An attempt whose process is gone before the worker ran (crashed)
 * is retried. A checkout that is not a readable Git repository is left to
 * the worker, which reports the failure itself.
 */
export async function claimMemoryConflictRepair(
  memoryDir: string,
): Promise<MemoryConflictRepairClaim> {
  const token = randomUUID();
  let path: string;
  let signature: string;
  try {
    path = await attemptPath(memoryDir);
    signature = await describeMemoryConflict(
      memoryDir,
      await getMemoryGitDir(memoryDir),
    );
  } catch {
    return { status: "claimed", token };
  }
  const previous = await readAttempt(path);
  if (previous.signature === signature) {
    if (previous.state === "done") return { status: "attempted" };
    if (
      typeof previous.pid === "number" &&
      (await isSameProcessRunning({
        pid: previous.pid,
        ...(typeof previous.started === "string" && {
          started: previous.started,
        }),
      }))
    ) {
      return { status: "in_progress" };
    }
  }
  const started = await getOwnProcessStartTime();
  const attempt: RepairAttempt = {
    signature,
    token,
    state: "launching",
    pid: process.pid,
    ...(started && { started }),
    attemptedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(attempt));
  return { status: "claimed", token };
}

/** The repair worker ran; the same conflict is not attempted again automatically. */
export async function completeMemoryConflictRepair(
  memoryDir: string,
  token: string,
): Promise<void> {
  try {
    const path = await attemptPath(memoryDir);
    const attempt = await readAttempt(path);
    if (attempt.token !== token) return;
    await writeFile(path, JSON.stringify({ ...attempt, state: "done" }));
  } catch {
    /* Not a repository; nothing was recorded. */
  }
}

/**
 * The attempt never ran (launch failed, cancelled, nothing left to repair);
 * let the next turn retry. Only the record for `token` is removed, so a
 * worker forgetting its attempt after the lease is gone cannot drop a newer
 * claim.
 */
export async function clearMemoryConflictRepair(
  memoryDir: string,
  token: string,
): Promise<void> {
  try {
    const path = await attemptPath(memoryDir);
    if ((await readAttempt(path)).token !== token) return;
    await rm(path, { force: true });
  } catch {
    /* Not a repository; nothing was recorded. */
  }
}
