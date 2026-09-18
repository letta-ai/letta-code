import type { MemoryPostTurnSyncResult } from "@/agent/memory-git";
import { buildMemoryRepairPrompt } from "@/agent/subagents/memory-worker";
import { spawnBackgroundSubagentTask } from "@/tools/impl/task";

export function startMemoryConflictRepair(
  params: {
    agentId: string;
    conversationId?: string | null;
    result: MemoryPostTurnSyncResult;
  },
  spawn = spawnBackgroundSubagentTask,
): void {
  spawn({
    subagentType: "memory",
    description: "Repair memory Git conflict",
    prompt: buildMemoryRepairPrompt(params.result),
    parentScope: {
      agentId: params.agentId,
      conversationId: params.conversationId ?? "default",
    },
    memoryScope: {
      primaryRoot: params.result.memoryDir,
      writableRoots: [params.result.memoryDir],
    },
    memoryRepairOnly: true,
    silentCompletion: true,
  });
}
