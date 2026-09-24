import type { SubagentResult } from "@/agent/subagents";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import {
  createExternalCodingAgentConfig,
  parseExternalCodingAgentId,
  runExternalCodingAgent,
} from "./external-coding-agent";
import {
  type SpawnBackgroundSubagentTaskResult,
  spawnBackgroundSubagentTask,
} from "./task";

export function trackExternalFollowupCompletion(args: {
  type: "claude-code" | "codex";
  agentId: string;
  message: string;
  parentScope: { agentId: string; conversationId: string };
  completion: Promise<SubagentResult>;
  interrupt: () => Promise<void>;
}): SpawnBackgroundSubagentTaskResult {
  return spawnBackgroundSubagentTask({
    subagentType: args.type,
    config: createExternalCodingAgentConfig(args.type),
    prompt: args.message,
    description: `Continue ${args.type} session`,
    existingAgentId: args.agentId,
    parentScope: args.parentScope,
    deps: {
      spawnSubagentImpl: async (
        _type,
        _prompt,
        _model,
        _subagentId,
        signal,
      ) => {
        const interrupt = () => void args.interrupt().catch(() => undefined);
        signal?.addEventListener("abort", interrupt, { once: true });
        if (signal?.aborted) interrupt();
        try {
          return await args.completion;
        } finally {
          signal?.removeEventListener("abort", interrupt);
        }
      },
    },
  });
}

export function spawnExternalCodingAgentFollowup(args: {
  agentId: string;
  message: string;
  parentScope: { agentId: string; conversationId: string };
}): SpawnBackgroundSubagentTaskResult {
  const target = parseExternalCodingAgentId(args.agentId);
  if (!target) {
    throw new Error(`Invalid external coding agent ID: ${args.agentId}`);
  }
  return spawnBackgroundSubagentTask({
    subagentType: target.type,
    config: createExternalCodingAgentConfig(target.type),
    prompt: args.message,
    description: `Continue ${target.type} session`,
    parentScope: args.parentScope,
    deps: {
      spawnSubagentImpl: async (_type, prompt, _model, _subagentId, signal) =>
        runExternalCodingAgent({
          type: target.type,
          prompt,
          parentAgentId: args.parentScope.agentId,
          resumeSessionId: target.sessionId,
          cwd: getCurrentWorkingDirectory(),
          signal,
        }),
    },
  });
}
