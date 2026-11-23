import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getMemoryGitDir } from "@/agent/memory-git-dir";
import { debugWarn } from "@/utils/debug";
import { type FileLockOptions, withFileLock } from "@/utils/file-lock";
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
export type MemoryRepairKind = "conflict" | "invalid";

interface RepairAttempt extends ProcessIdentity {
  signature: string;
  token: string;
  state: "launching" | "done";
  attemptedAt: string;
}

export type MemoryConflictRepairClaim =
  | { status: "claimed"; token: string }
  | { status: "in_progress" }
  | { status: "attempted" };

async function readOptional(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

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
  } catch {}
  const heads = await Promise.all(
    OPERATION_HEADS.map((name) => readOptional(join(gitDir, name))),
  );
  return [head, ...heads].join("\n");
}

async function describeInvalidMemoryHistory(
  memoryDir: string,
): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)("git", [
      "-C",
      memoryDir,
      "rev-parse",
      "--verify",
      "@{u}",
    ]);
    return `invalid\n${stdout.trim()}`;
  } catch {
    return "invalid";
  }
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

const MARKER_LOCK: FileLockOptions = { reapOnlyDeadOwner: true };
const CLAIM_TIMEOUT_MS = 5_000;

async function updateAttempt<T>(
  path: string,
  fn: (attempt: Partial<RepairAttempt>) => Promise<T>,
  timeoutMs = Number.POSITIVE_INFINITY,
): Promise<T> {
  return withFileLock(`${path}.lock`, async () => fn(await readAttempt(path)), {
    ...MARKER_LOCK,
    timeoutMs,
  });
}

async function transition(
  memoryDir: string,
  fn: (path: string, attempt: Partial<RepairAttempt>) => Promise<void>,
): Promise<void> {
  let path: string;
  try {
    path = await attemptPath(memoryDir);
  } catch {
    return;
  }
  try {
    await updateAttempt(path, (attempt) => fn(path, attempt));
  } catch (error) {
    debugWarn("memory-repair", `Repair attempt not updated: ${String(error)}`);
  }
}

export async function claimMemoryConflictRepair(
  memoryDir: string,
  kind: MemoryRepairKind = "conflict",
): Promise<MemoryConflictRepairClaim> {
  const token = randomUUID();
  let path: string;
  let signature: string;
  try {
    const gitDir = await getMemoryGitDir(memoryDir);
    path = join(gitDir, ATTEMPT_FILE);
    signature =
      kind === "invalid"
        ? await describeInvalidMemoryHistory(memoryDir)
        : await describeMemoryConflict(memoryDir, gitDir);
  } catch {
    return { status: "claimed", token };
  }
  return updateAttempt(
    path,
    async (previous) => {
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
    },
    CLAIM_TIMEOUT_MS,
  );
}

export async function completeMemoryConflictRepair(
  memoryDir: string,
  token: string,
): Promise<void> {
  await transition(memoryDir, async (path, attempt) => {
    if (attempt.token !== token) return;
    await writeFile(path, JSON.stringify({ ...attempt, state: "done" }));
  });
}

export async function clearMemoryConflictRepair(
  memoryDir: string,
  token: string,
): Promise<void> {
  await transition(memoryDir, async (path, attempt) => {
    if (attempt.token === token) await rm(path, { force: true });
  });
}
