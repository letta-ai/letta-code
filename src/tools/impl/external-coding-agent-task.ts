import type { SubagentResult } from "@/agent/subagents";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import {
  createExternalCodingAgentConfig,
  parseExternalCodingAgentId,
  runExternalCodingAgent,
} from "./external-coding-agent";
import {
  captureNativeSession,
  type NativeSessionCaptureReservation,
  reportNativeSessionCaptureFailure,
} from "./native-session-capture";
import {
  type SpawnBackgroundSubagentTaskResult,
  spawnBackgroundSubagentTask,
} from "./task";

export function trackExternalFollowupCompletion(args: {
  type: "claude-code" | "codex";
  agentId: string;
  message: string;
  parentScope: {
    agentId: string;
    conversationId: string;
    actingUserId?: string | null;
  };
  completion: Promise<SubagentResult>;
  interrupt: () => Promise<void>;
  captureReservation?: NativeSessionCaptureReservation;
}): SpawnBackgroundSubagentTaskResult {
  return spawnBackgroundSubagentTask({
    subagentType: args.type,
    config: createExternalCodingAgentConfig(args.type),
    prompt: args.message,
    description: `Continue ${args.type} session`,
    existingAgentId: args.agentId,
    parentScope: args.parentScope,
    actingUserId: args.parentScope.actingUserId,
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
        let result: SubagentResult | undefined;
        let completionError: unknown;
        let completionFailed = false;
        try {
          result = await args.completion;
        } catch (error) {
          completionError = error;
          completionFailed = true;
        } finally {
          signal?.removeEventListener("abort", interrupt);
        }
        const target = parseExternalCodingAgentId(args.agentId);
        if (target) {
          const source =
            target.type === "claude-code" ? "claude_code" : "codex";
          try {
            if (args.captureReservation) {
              await args.captureReservation.capture();
            } else {
              await captureNativeSession(
                source,
                target.sessionId,
                args.parentScope,
              );
            }
          } catch (error) {
            reportNativeSessionCaptureFailure(source, target.sessionId, error);
          }
        }
        if (completionFailed) throw completionError;
        if (!result)
          throw new Error("External coding agent returned no result");
        return result;
      },
    },
  });
}

export function spawnExternalCodingAgentFollowup(args: {
  agentId: string;
  message: string;
  parentScope: {
    agentId: string;
    conversationId: string;
    actingUserId?: string | null;
  };
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
    actingUserId: args.parentScope.actingUserId,
    deps: {
      spawnSubagentImpl: async (_type, prompt, _model, _subagentId, signal) =>
        runExternalCodingAgent({
          type: target.type,
          prompt,
          parentAgentId: args.parentScope.agentId,
          parentConversationId: args.parentScope.conversationId,
          actingUserId: args.parentScope.actingUserId,
          resumeSessionId: target.sessionId,
          cwd: getCurrentWorkingDirectory(),
          signal,
        }),
    },
  });
}
