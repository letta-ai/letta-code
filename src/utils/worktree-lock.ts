import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "@/utils/fs";

/**
 * Cross-agent advisory lock so two conversations do not both switch into the
 * same worktree and clobber each other's uncommitted work. The lock is a small
 * JSON file written into the worktree's per-worktree git admin directory
 * (`<common>/worktrees/<name>/`), which keeps it out of the working tree and
 * lets `git worktree remove` clean it up automatically.
 *
 * This module is the pure file-backed primitive (acquire/release plus ownership
 * and liveness rules). The session-aware orchestration that resolves git dirs
 * and reads the runtime context lives with the worktree tool.
 */
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
    // Signal 0 performs error checking without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH => no such process. EPERM => the process exists but we may not
    // signal it, which still means it is alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isHeldByUs(lock: WorktreeLock, owner: WorktreeLockOwner): boolean {
  if (owner.conversationId) {
    return lock.conversationId === owner.conversationId;
  }
  // Anonymous owner (no conversation id): the lock is ours only if this exact
  // process wrote it without a conversation id either.
  return (
    lock.conversationId === null &&
    lock.hostname === HOSTNAME &&
    lock.pid === process.pid
  );
}

/**
 * A lock is stale (safe to reclaim) when the process that wrote it is gone. We
 * can only judge liveness on the same host; locks from another machine are
 * treated as live and require `force` to override.
 */
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

/**
 * Acquires (or refreshes) the advisory lock for a worktree on behalf of
 * `owner`. Returns a `conflict` outcome when the worktree is actively held by a
 * different, live owner and `force` is not set; otherwise writes the lock and
 * reports how it was obtained.
 */
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

/** Releases `owner`'s lock on a worktree. No-op if it is held by someone else. */
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
