import {
  type RepositoriesPostTurnSyncResult,
  type RepositoryPostTurnSyncResult,
  syncPendingAttachedRepositoryCommitsAfterTurn,
} from "@/agent/attached-repository-git-sync";
import {
  type MemoryPostTurnSyncResult,
  syncPendingMemoryCommitsAfterTurn,
} from "@/agent/memory-git";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { debugWarn } from "@/utils/debug";

export interface RunPostTurnMemorySyncParams {
  agentId: string;
  isEnabled?: (agentId: string) => boolean;
  launchConversation?: (text: string) => void | Promise<void>;
  emitWarning?: (text: string) => void | Promise<void>;
  debugLabel?: string;
}

export interface RunPostTurnMemorySyncDependencies {
  syncMemory?: typeof syncPendingMemoryCommitsAfterTurn;
  syncAttachedRepositories?: typeof syncPendingAttachedRepositoryCommitsAfterTurn;
}

export function formatMemoryPostTurnSyncReminder(
  result: MemoryPostTurnSyncResult,
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
MEMORY GIT CONFLICT: The memory repository needs manual conflict resolution.

Memory directory: ${result.memoryDir}
Status: ${result.summary}

Resolve the merge/rebase conflicts in the memory repository, stage the resolved files, and complete the merge/rebase or create the needed commit. The harness will retry remote push after a future turn when the repo is clean.
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

${action} when appropriate. Do not run \`git push\` for MemFS sync; the harness pushes clean committed memory changes automatically for remote MemFS agents after turns.
${SYSTEM_REMINDER_CLOSE}`;
  }

  return `${SYSTEM_REMINDER_OPEN}
MEMORY SYNC FAILED: The harness could not push pending memory commits.

Memory directory: ${result.memoryDir}
Status: ${result.summary}

Inspect the memory repository and resolve any local git issue. The harness will retry remote push after a future turn when the repo is clean.
${SYSTEM_REMINDER_CLOSE}`;
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
  const debugLabel = params.debugLabel ?? "Post-turn memory sync";
  const syncMemory =
    dependencies.syncMemory ?? syncPendingMemoryCommitsAfterTurn;
  const syncAttachedRepositories =
    dependencies.syncAttachedRepositories ??
    syncPendingAttachedRepositoryCommitsAfterTurn;
  let memorySyncEnabled = true;
  const actionRequired: string[] = [];

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
      const syncResult = await syncMemory(params.agentId);
      const syncReminder = formatMemoryPostTurnSyncReminder(syncResult);
      if (syncReminder) {
        actionRequired.push(syncReminder);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugWarn("memfs-git", `${debugLabel} failed: ${message}`);
      actionRequired.push(`${SYSTEM_REMINDER_OPEN}
MEMORY SYNC FAILED: The harness could not inspect or synchronize the memory repository.

Status: ${message}

Inspect the memory repository and resolve any local git issue.
${SYSTEM_REMINDER_CLOSE}`);
    }
  }

  try {
    const repositorySyncResult = await syncAttachedRepositories(params.agentId);
    for (const reminder of formatAttachedRepositoriesPostTurnSyncReminders(
      repositorySyncResult,
    )) {
      actionRequired.push(reminder);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugWarn(
      "memfs-git",
      `${debugLabel} shared-memory sync failed: ${message}`,
    );
    actionRequired.push(`${SYSTEM_REMINDER_OPEN}
SHARED MEMORY SYNC FAILED: The harness could not inspect or synchronize attached shared-memory repositories.

Status: ${message}

Inspect the attached repositories and resolve any local git issue.
${SYSTEM_REMINDER_CLOSE}`);
  }

  if (actionRequired.length === 0) return;
  const context = actionRequired.join("\n\n");
  await params.launchConversation?.(context);
  await params.emitWarning?.(context);
}
