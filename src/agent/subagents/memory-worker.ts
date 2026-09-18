import {
  type MemoryPostTurnSyncResult,
  syncPendingMemoryCommitsAfterTurn,
} from "@/agent/memory-git";
import { withMemoryOperation } from "@/agent/memory-operation";
import { recompileAgentSystemPrompt } from "@/agent/modify";
import { getBackend } from "@/backend";
import { debugWarn } from "@/utils/debug";
import type { SubagentResult } from ".";

export const MEMORY_WORKER_SESSION_ENV = "LETTA_MEMORY_WORKER_SESSION";

export function isMemoryWorkerSession(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[MEMORY_WORKER_SESSION_ENV] === "1";
}

export function buildMemoryRepairPrompt(
  result: MemoryPostTurnSyncResult,
): string {
  return `Repair only the existing Git conflict in your memory repository. Do not perform unrelated edits or reorganization. If the conflict is already resolved, stop.\n\nMemory directory: ${result.memoryDir}\nReported status: ${result.summary}`;
}

/** Called inside the existing background task, never awaited by the primary. */
export async function runMemoryWorker(
  params: {
    agentId: string;
    conversationId: string;
    memoryDir: string;
    repairOnly?: boolean;
    signal?: AbortSignal;
  },
  execute: () => Promise<SubagentResult>,
  deps: {
    sync?: typeof syncPendingMemoryCommitsAfterTurn;
    recompile?: typeof recompileAgentSystemPrompt;
    repair?: (result: MemoryPostTurnSyncResult) => void;
  } = {},
): Promise<SubagentResult> {
  const sync = () =>
    (deps.sync ?? syncPendingMemoryCommitsAfterTurn)(params.agentId, {
      memoryDir: params.memoryDir,
    });
  return withMemoryOperation(
    params.memoryDir,
    async () => {
      // Another worker may have repaired the checkout before this one acquired it.
      if (params.repairOnly && (await sync()).status !== "conflict") {
        return {
          agentId: params.agentId,
          success: true,
          report: "No memory conflict remains.",
        };
      }
      try {
        return await execute();
      } finally {
        // Normal sync owns Git status checks and remote retries.
        try {
          const result = await sync();
          if (
            result.status === "clean" ||
            result.status === "pushed" ||
            result.status === "skipped"
          ) {
            if (deps.recompile || getBackend().capabilities.promptRecompile) {
              await (deps.recompile ?? recompileAgentSystemPrompt)(
                params.conversationId,
                params.agentId,
              );
            }
          } else {
            debugWarn("memory-worker", result.summary);
            if (result.status === "conflict" && !params.repairOnly) {
              deps.repair?.(result);
            }
          }
        } catch (error) {
          debugWarn("memory-worker", `Memory sync failed: ${String(error)}`);
        }
      }
    },
    params.signal,
  );
}
