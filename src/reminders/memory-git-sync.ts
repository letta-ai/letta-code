import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type RepositoryPostTurnSyncResult,
  syncPendingAttachedRepositoryCommitsAfterTurn,
} from "@/agent/attached-repository-git-sync";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  type MemoryPostTurnSyncResult,
  syncPendingMemoryCommitsAfterTurn,
} from "@/agent/memory-git";
import { claimMemoryOperation } from "@/agent/memory-operation";
import { isMemoryWorkerSession } from "@/agent/subagents/memory-worker-session";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { ensureMemoryConflictRepair } from "@/tools/impl/memory-task-lifecycle";
import { spawnBackgroundSubagentTask } from "@/tools/impl/task";
import { debugWarn } from "@/utils/debug";

export interface RunPostTurnMemorySyncParams {
  agentId: string;
  conversationId?: string | null;
  isEnabled?: (agentId: string) => boolean;
  /** Deliver a reminder to the agent on its next turn. */
  enqueueReminder?: (text: string) => void;
  /** Show the user something the agent cannot act on: a push that failed. */
  emitWarning?: (text: string) => void | Promise<void>;
  onMemoryPushed?: () => void;
  debugLabel?: string;
}

export interface RunPostTurnMemorySyncDependencies {
  syncMemory?: typeof syncPendingMemoryCommitsAfterTurn;
  repairConflict?: (
    params: Parameters<typeof ensureMemoryConflictRepair>[0],
  ) => Promise<boolean>;
  claimOperation?: typeof claimMemoryOperation;
  syncAttachedRepositories?: typeof syncPendingAttachedRepositoryCommitsAfterTurn;
}

/** A repair worker is editing the checkout in place; the primary must leave it alone until it finishes. */
export function formatMemoryRepairInProgressReminder(
  result: MemoryPostTurnSyncResult,
): string {
  return `${SYSTEM_REMINDER_OPEN}
MEMORY REPAIR IN PROGRESS: A background worker is resolving an unfinished merge or rebase in the memory repository.

Memory directory: ${result.memoryDir}
Status: ${result.summary}

Do not edit memory files or run Git commands in the memory repository until the worker's task log ends with [Task completed] or [Task failed]; its changes would be swept into the repair or overwritten. Reading memory is fine.
${SYSTEM_REMINDER_CLOSE}`;
}

/**
 * Reminders for the primary's own post-turn MemFS sync. A conflict is normally
 * handed to a background repair worker; the conflict reminder is for one no
 * worker is handling any more. A failed push is not the agent's to fix (the
 * harness retries after the next turn), so it is reported to the user instead.
 */
export function formatMemoryPostTurnSyncReminder(
  result: MemoryPostTurnSyncResult,
): string | null {
  if (result.status === "conflict") {
    return `${SYSTEM_REMINDER_OPEN}
MEMORY GIT CONFLICT: The memory repository has an unfinished merge or rebase that automatic repair could not resolve.

Memory directory: ${result.memoryDir}
Status: ${result.summary}

Resolve the conflicts in the memory repository, stage the resolved files, and complete the merge/rebase or create the needed commit. The harness will retry remote push after a future turn when the repo is clean.
${SYSTEM_REMINDER_CLOSE}`;
  }

  if (result.status === "dirty") {
    const action = result.localOnly
      ? "Commit these memory changes locally"
      : "Commit these memory changes";
    return `${SYSTEM_REMINDER_OPEN}
MEMORY COMMIT NEEDED: The memory repository has uncommitted changes.

Memory directory: ${result.memoryDir}
Status: ${result.summary}

${action} when appropriate, staging only the files you changed. Do not run \`git push\` for MemFS sync; the harness pushes clean committed memory changes automatically for remote MemFS agents after turns.
${SYSTEM_REMINDER_CLOSE}`;
  }

  return null;
}

/** A push the harness could not complete; shown to the user, not the agent. */
export function formatMemoryPushFailureNotice(
  result: MemoryPostTurnSyncResult | RepositoryPostTurnSyncResult,
): string {
  const target =
    "name" in result
      ? `attached shared-memory repository "${result.name}"`
      : "memory repository";
  return `Could not push the ${target}: ${result.summary} The harness will retry after the next turn.`;
}

export function formatAttachedRepositoryPostTurnSyncReminder(
  result: RepositoryPostTurnSyncResult,
): string | null {
  if (result.status === "conflict") {
    return `${SYSTEM_REMINDER_OPEN}
SHARED MEMORY GIT CONFLICT: The attached shared-memory repository "${result.name}" needs manual conflict resolution.

Repository directory: ${result.path}
Status: ${result.summary}

Resolve the merge/rebase conflicts, stage the resolved files, and complete the merge/rebase or create the needed commit. The harness will retry the push after a future turn when the repository is clean.
${SYSTEM_REMINDER_CLOSE}`;
  }

  if (result.status === "dirty") {
    return `${SYSTEM_REMINDER_OPEN}
SHARED MEMORY COMMIT NEEDED: The attached shared-memory repository "${result.name}" has uncommitted changes.

Repository directory: ${result.path}
Status: ${result.summary}

Commit these changes when appropriate. The harness pushes clean committed changes for read/write attached shared memory after turns.
${SYSTEM_REMINDER_CLOSE}`;
  }

  return null;
}

/**
 * Deliver at most one copy of a repository's current notice. The same dirty
 * checkout or unresolved conflict would otherwise be re-announced after every
 * turn until someone acts, and the agent already has the first copy in its
 * context. A changed or cleared state resets it. Reminders are remembered
 * per conversation, since each conversation has its own context to inform;
 * the user-facing push warning per repository.
 */
const lastNotices = new Map<string, string>();

async function deliverOnce(
  key: string,
  text: string | null,
  deliver: (text: string) => void | Promise<void>,
): Promise<void> {
  if (text === null) {
    lastNotices.delete(key);
    return;
  }
  if (lastNotices.get(key) === text) return;
  lastNotices.set(key, text);
  await deliver(text);
}

/** Reset the per-repository delivery memory (tests). */
export function resetPostTurnMemorySyncNotices(): void {
  lastNotices.clear();
}

async function deliverPostTurnNotice(
  params: RunPostTurnMemorySyncParams,
  key: string,
  result: MemoryPostTurnSyncResult | RepositoryPostTurnSyncResult,
  reminder: string | null,
): Promise<void> {
  if (result.status === "push_failed") {
    await deliverOnce(key, formatMemoryPushFailureNotice(result), (text) =>
      params.emitWarning?.(text),
    );
    return;
  }
  await deliverOnce(
    `${params.conversationId ?? ""}\n${key}`,
    reminder,
    (text) => params.enqueueReminder?.(text),
  );
}

export async function runPostTurnMemorySync(
  params: RunPostTurnMemorySyncParams,
  dependencies: RunPostTurnMemorySyncDependencies = {},
): Promise<void> {
  if (isMemoryWorkerSession()) return;
  const debugLabel = params.debugLabel ?? "Post-turn memory sync";
  const syncMemory =
    dependencies.syncMemory ?? syncPendingMemoryCommitsAfterTurn;
  const syncAttachedRepositories =
    dependencies.syncAttachedRepositories ??
    syncPendingAttachedRepositoryCommitsAfterTurn;
  const repairConflict =
    dependencies.repairConflict ??
    ((repair) =>
      ensureMemoryConflictRepair(repair, spawnBackgroundSubagentTask));
  let memorySyncEnabled = true;

  try {
    if (params.isEnabled && !params.isEnabled(params.agentId)) {
      memorySyncEnabled = false;
    }
  } catch (error) {
    memorySyncEnabled = false;
    debugWarn(
      "memfs-git",
      `Skipping ${debugLabel} for MemFS because settings are unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (memorySyncEnabled) {
    try {
      const memoryDir = getScopedMemoryFilesystemRoot(params.agentId);
      const release = existsSync(join(memoryDir, ".git"))
        ? await (dependencies.claimOperation ?? claimMemoryOperation)(memoryDir)
        : undefined;
      if (release !== null) {
        try {
          const result = await syncMemory(params.agentId);
          if (result.status === "pushed") params.onMemoryPushed?.();
          const repairInProgress =
            result.status === "conflict" &&
            (await repairConflict({ ...params, result }));
          await deliverPostTurnNotice(
            params,
            memoryDir,
            result,
            repairInProgress
              ? formatMemoryRepairInProgressReminder(result)
              : formatMemoryPostTurnSyncReminder(result),
          );
        } finally {
          await release?.();
        }
      }
    } catch (error) {
      debugWarn(
        "memfs-git",
        `${debugLabel} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  try {
    const repositorySyncResult = await syncAttachedRepositories(params.agentId);
    for (const result of repositorySyncResult.results) {
      await deliverPostTurnNotice(
        params,
        result.path,
        result,
        formatAttachedRepositoryPostTurnSyncReminder(result),
      );
    }
  } catch (error) {
    debugWarn(
      "memfs-git",
      `${debugLabel} shared-memory sync failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
