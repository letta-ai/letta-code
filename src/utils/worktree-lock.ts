import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "@/utils/fs";

export const LOCK_FILENAME = "letta-enter.lock";

const HOSTNAME = os.hostname();

export interface WorktreeLockOwner {
  conversationId: string | null;
  agentId: string | null;
}

export interface WorktreeLock {
  conversationId: string | null;
  agentId: string | null;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export type WorktreeLockOutcome =
  | {
      outcome: "acquired" | "reentrant" | "reclaimed" | "forced";
      lock: WorktreeLock;
      previous?: WorktreeLock;
    }
  | { outcome: "conflict"; heldBy: WorktreeLock };

async function readWorktreeLock(gitDir: string): Promise<WorktreeLock | null> {
  try {
    const parsed = await readJsonFile<Partial<WorktreeLock>>(
      path.join(gitDir, LOCK_FILENAME),
    );
    if (typeof parsed.pid !== "number") {
      return null;
    }
    return {
      conversationId:
        typeof parsed.conversationId === "string"
          ? parsed.conversationId
          : null,
      agentId: typeof parsed.agentId === "string" ? parsed.agentId : null,
      pid: parsed.pid,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : "",
      acquiredAt:
        typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
    };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isHeldByUs(lock: WorktreeLock, owner: WorktreeLockOwner): boolean {
  if (owner.conversationId) {
    return lock.conversationId === owner.conversationId;
  }
  return (
    lock.conversationId === null &&
    lock.hostname === HOSTNAME &&
    lock.pid === process.pid
  );
}

function isStaleLock(lock: WorktreeLock): boolean {
  const sameHost = !lock.hostname || lock.hostname === HOSTNAME;
  return sameHost && !processIsAlive(lock.pid);
}

export function describeHolder(lock: WorktreeLock): string {
  if (lock.conversationId) {
    return `conversation ${lock.conversationId}`;
  }
  return `process ${lock.pid}${lock.hostname ? ` on ${lock.hostname}` : ""}`;
}

export async function acquireWorktreeLock(params: {
  worktreeGitDir: string;
  owner: WorktreeLockOwner;
  force?: boolean;
}): Promise<WorktreeLockOutcome> {
  const { worktreeGitDir, owner } = params;
  const force = params.force === true;
  const existing = await readWorktreeLock(worktreeGitDir);

  let outcome: "acquired" | "reentrant" | "reclaimed" | "forced";
  if (!existing) {
    outcome = "acquired";
  } else if (isHeldByUs(existing, owner)) {
    outcome = "reentrant";
  } else if (isStaleLock(existing)) {
    outcome = "reclaimed";
  } else if (force) {
    outcome = "forced";
  } else {
    return { outcome: "conflict", heldBy: existing };
  }

  const lock: WorktreeLock = {
    conversationId: owner.conversationId,
    agentId: owner.agentId,
    pid: process.pid,
    hostname: HOSTNAME,
    acquiredAt: new Date().toISOString(),
  };
  await writeJsonFile(path.join(worktreeGitDir, LOCK_FILENAME), lock);
  return { outcome, lock, previous: existing ?? undefined };
}

export async function releaseWorktreeLock(params: {
  worktreeGitDir: string;
  owner: WorktreeLockOwner;
}): Promise<boolean> {
  const existing = await readWorktreeLock(params.worktreeGitDir);
  if (!existing || !isHeldByUs(existing, params.owner)) {
    return false;
  }
  await unlink(path.join(params.worktreeGitDir, LOCK_FILENAME)).catch(() => {});
  return true;
}
