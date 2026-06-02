import type { MemoryPostTurnSyncResult } from "@/agent/memory-git";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";

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
