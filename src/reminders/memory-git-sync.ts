import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type RepositoriesPostTurnSyncResult,
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
import { startMemoryConflictRepair } from "@/tools/impl/task";
import { debugWarn } from "@/utils/debug";

export interface RunPostTurnMemorySyncParams {
  agentId: string;
  conversationId?: string | null;
  isEnabled?: (agentId: string) => boolean;
  enqueueReminder?: (text: string) => void;
  emitWarning?: (text: string) => void | Promise<void>;
  onMemoryPushed?: () => void;
  debugLabel?: string;
}

export interface RunPostTurnMemorySyncDependencies {
  syncMemory?: typeof syncPendingMemoryCommitsAfterTurn;
  repairConflict?: typeof startMemoryConflictRepair;
  claimOperation?: typeof claimMemoryOperation;
  syncAttachedRepositories?: typeof syncPendingAttachedRepositoryCommitsAfterTurn;
}

/**
 * Reminders for the primary's own post-turn MemFS sync. A conflict is normally
 * handed to a background repair worker, so callers pass `conflict` only when
 * that repair was not launched.
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

  if (result.status === "push_failed") {
    return `${SYSTEM_REMINDER_OPEN}
MEMORY SYNC FAILED: The harness could not push pending memory commits.

Memory directory: ${result.memoryDir}
Status: ${result.summary}

Inspect the memory repository and resolve any local git issue. The harness will retry remote push after a future turn when the repo is clean.
${SYSTEM_REMINDER_CLOSE}`;
  }

  return null;
}

export function formatAttachedRepositoryPostTurnSyncReminder(
  result: RepositoryPostTurnSyncResult,
): string | null {
  if (
    result.status === "clean" ||
    result.status === "pushed" ||
    result.status === "skipped"
  ) {
    return null;
  }

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

  return `${SYSTEM_REMINDER_OPEN}
SHARED MEMORY SYNC FAILED: The harness could not push pending commits for attached shared-memory repository "${result.name}".

Repository directory: ${result.path}
Status: ${result.summary}

Inspect the repository and resolve any local git issue. The harness will retry the push after a future turn when the repository is clean.
${SYSTEM_REMINDER_CLOSE}`;
}

export function formatAttachedRepositoriesPostTurnSyncReminders(
  result: RepositoriesPostTurnSyncResult,
): string[] {
  return result.results
    .map(formatAttachedRepositoryPostTurnSyncReminder)
    .filter((reminder): reminder is string => reminder !== null);
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
          const repairLaunched =
            result.status === "conflict" &&
            (await (dependencies.repairConflict ?? startMemoryConflictRepair)({
              ...params,
              result,
            }));
          const reminder = repairLaunched
            ? null
            : formatMemoryPostTurnSyncReminder(result);
          if (reminder) {
            params.enqueueReminder?.(reminder);
            await params.emitWarning?.(reminder);
          }
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
    for (const reminder of formatAttachedRepositoriesPostTurnSyncReminders(
      repositorySyncResult,
    )) {
      params.enqueueReminder?.(reminder);
      await params.emitWarning?.(reminder);
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
