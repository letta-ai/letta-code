import { syncPendingMemoryCommitsAfterTurn } from "@/agent/memory-git";
import { withMemoryOperation } from "@/agent/memory-operation";
import { recompileAgentSystemPrompt } from "@/agent/modify";
import { getBackend } from "@/backend";
import { debugWarn } from "@/utils/debug";
import type { SubagentResult } from ".";

/** Called inside the existing background task, never awaited by the primary. */
export async function runMemoryWorker(
  params: {
    agentId: string;
    conversationId: string;
    memoryDir: string;
    signal?: AbortSignal;
  },
  execute: () => Promise<SubagentResult>,
  deps: {
    sync?: typeof syncPendingMemoryCommitsAfterTurn;
    recompile?: typeof recompileAgentSystemPrompt;
    onMemoryPushed?: () => void;
  } = {},
): Promise<SubagentResult> {
  const sync = async () => {
    const result = await (deps.sync ?? syncPendingMemoryCommitsAfterTurn)(
      params.agentId,
      {
        memoryDir: params.memoryDir,
      },
    );
    if (result.status === "pushed") deps.onMemoryPushed?.();
    return result;
  };
  return withMemoryOperation(
    params.memoryDir,
    async () => {
      let result: SubagentResult;
      let syncError: string | undefined;
      let synced = false;
      try {
        result = await execute();
      } finally {
        // Normal sync owns Git status checks and remote retries.
        try {
          const syncResult = await sync();
          if (
            syncResult.status === "clean" ||
            syncResult.status === "pushed" ||
            syncResult.status === "skipped"
          ) {
            synced = true;
          } else {
            syncError = `Memory sync incomplete (${syncResult.status}): ${syncResult.summary}`;
            debugWarn("memory-worker", syncError);
          }
        } catch (error) {
          syncError = `Memory sync failed: ${String(error)}`;
          debugWarn("memory-worker", syncError);
        }
      }
      // Memory is committed and synced at this point; a failed prompt refresh
      // is worth a warning but must not report the worker as failed. Running
      // it under the checkout lock is safe because the primary's tools never
      // take this lock, so its active turn cannot be waiting on us.
      if (synced) {
        try {
          if (deps.recompile || getBackend().capabilities.promptRecompile) {
            await (deps.recompile ?? recompileAgentSystemPrompt)(
              params.conversationId,
              params.agentId,
            );
          }
        } catch (error) {
          debugWarn(
            "memory-worker",
            `System prompt recompile failed after memory sync: ${String(error)}`,
          );
        }
      }
      return syncError
        ? { ...result, success: false, error: result.error ?? syncError }
        : result;
    },
    params.signal,
  );
}
