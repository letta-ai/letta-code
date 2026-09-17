import {
  getMemoryConflictSummary,
  type MemoryPostTurnSyncResult,
  syncPendingMemoryCommitsAfterTurn,
} from "@/agent/memory-git";
import { MEMORY_REPAIR_SUBAGENT_TYPE } from "@/agent/memory-repair-policy";
import { claimMemoryRepair } from "@/agent/memory-repair-state";
import { getBackend } from "@/backend";
import type { SpawnBackgroundSubagentTaskArgs } from "@/tools/impl/task";
import { debugWarn } from "@/utils/debug";

interface MemoryConflictRepairParams {
  agentId: string;
  conversationId?: string | null;
  waitForCompletion?: boolean;
  result: MemoryPostTurnSyncResult;
}

interface MemoryConflictRepairDependencies {
  createConversation?: (agentId: string) => Promise<string>;
  spawn?: (args: SpawnBackgroundSubagentTaskArgs) => void;
  syncMemory?: typeof syncPendingMemoryCommitsAfterTurn;
}

export function buildMemoryConflictRepairPrompt(
  result: MemoryPostTurnSyncResult,
): string {
  return `Repair the Git conflict in your memory repository in this separate, hidden conversation. Do not interrupt, send messages to, or ask questions in the original conversation.

Memory directory: ${result.memoryDir}
Reported status: ${result.summary}

Start by inspecting the current Git status and merge/rebase state in this directory. The report may be stale: if there is no conflict or unfinished operation, stop without changing anything.

Resolve conflicts by inspecting both sides and preserving the intended memory. Stage only resolved files and complete the existing merge/rebase (use a noninteractive Git editor when continuing). Preserve unrelated uncommitted changes; do not stash, discard, reset, or commit them. Do not abort the operation, choose one side wholesale, amend existing commits, or push.

Work only in the named memory repository. Do not perform reflection or unrelated memory cleanup. If a safe resolution is unclear, leave the remaining conflict intact and explain the blocker here. Otherwise verify that no conflicts or unfinished Git operation remain and provide a brief summary here. The harness will verify the result and retry the remote push.`;
}

/** Launches a separate conversation; neither the prompt nor completion enters the parent. */
export async function startMemoryConflictRepair(
  params: MemoryConflictRepairParams,
  dependencies: MemoryConflictRepairDependencies = {},
): Promise<void> {
  const release = await claimMemoryRepair(params.result.memoryDir);
  if (!release) return;
  try {
    // A different process may have fixed the conflict before we acquired the claim.
    if (!(await getMemoryConflictSummary(params.result.memoryDir))) {
      await release(true);
      return;
    }
    const createConversation =
      dependencies.createConversation ??
      (async (agentId) => {
        const body = {
          agent_id: agentId,
          hidden: true,
          summary: "Memory conflict repair",
        };
        const conversation = await getBackend().createConversation(body);
        return conversation.id;
      });
    const conversationId = await createConversation(params.agentId);
    const spawn =
      dependencies.spawn ??
      (await import("@/tools/impl/task")).spawnBackgroundSubagentTask;
    let finish = () => {};
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    spawn({
      subagentType: MEMORY_REPAIR_SUBAGENT_TYPE,
      displayType: "memory repair",
      description: "Resolve memory Git conflicts",
      prompt: buildMemoryConflictRepairPrompt(params.result),
      existingAgentId: params.agentId,
      existingConversationId: conversationId,
      parentScope: {
        agentId: params.agentId,
        conversationId: params.conversationId ?? "default",
      },
      memoryScope: {
        primaryRoot: params.result.memoryDir,
        writableRoots: [params.result.memoryDir],
      },
      maxTurns: 20,
      silentCompletion: true,
      onComplete: async (completion) => {
        let resolved = false;
        try {
          // Verify Git state even if the model reports success (or fails after committing).
          const result = await (
            dependencies.syncMemory ?? syncPendingMemoryCommitsAfterTurn
          )(params.agentId, { memoryDir: params.result.memoryDir });
          resolved =
            result.status === "clean" ||
            result.status === "pushed" ||
            result.status === "skipped";
          if (!resolved) {
            debugWarn(
              "memfs-git",
              `Memory repair ${conversationId} remains ${result.status}: ${result.summary}`,
            );
          } else if (!completion.success) {
            debugWarn(
              "memfs-git",
              `Memory repair ${conversationId} exited with an error after resolving the repository: ${completion.error}`,
            );
          }
        } catch (error) {
          debugWarn(
            "memfs-git",
            `Memory repair ${conversationId} verification failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          try {
            await release(resolved);
          } finally {
            finish();
          }
        }
      },
    });
    if (params.waitForCompletion) await completed;
  } catch (error) {
    await release(false);
    throw error;
  }
}
