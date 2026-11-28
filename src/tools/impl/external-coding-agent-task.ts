import type { SubagentResult } from "@/agent/subagents";
import { resumeSubagentWriter } from "@/backend/api/subagents";
import {
  getCurrentWorkingDirectory,
  getRuntimeActingUserAttribution,
} from "@/runtime-context";
import {
  createExternalCodingAgentConfig,
  type ExternalCodingAgentType,
  parseExternalCodingAgentId,
  runExternalCodingAgent,
} from "./external-coding-agent";
import {
  captureNativeSession,
  type NativeSessionCaptureReservation,
  reportNativeSessionCaptureFailure,
} from "./native-session-capture";
import { getNextTaskId } from "./process_manager";
import { persistedSubagentStatus } from "./subagent-persistence";
import {
  type SpawnBackgroundSubagentTaskResult,
  spawnBackgroundSubagentTask,
} from "./task";
import { externalWorkerProgressListeners } from "./task-transcript";

export function trackExternalFollowupCompletion(args: {
  taskId?: string;
  type: ExternalCodingAgentType;
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
  toolCallId?: string;
  publishResult?: boolean;
  emitCompletionNotification?: boolean;
  claimsParentRuntime?: boolean;
}): SpawnBackgroundSubagentTaskResult {
  return spawnBackgroundSubagentTask({
    observePersistedState: args.publishResult
      ? undefined
      : () => {
          const writer = resumeSubagentWriter(
            args.parentScope.conversationId,
            { worker_session_id: args.agentId },
            args.parentScope.actingUserId === undefined
              ? getRuntimeActingUserAttribution()
              : args.parentScope.actingUserId,
          );
          let stopped = false;
          return (state) => {
            const status = stopped ? "stopped" : persistedSubagentStatus(state);
            stopped = status === "stopped";
            writer?.update({ status, worker_session_id: args.agentId });
          };
        },
    taskId: args.taskId,
    subagentType: args.type,
    config: createExternalCodingAgentConfig(args.type),
    prompt: args.message,
    description: `Continue ${args.type} session`,
    existingAgentId: args.agentId,
    toolCallId: args.toolCallId,
    publishResult: args.publishResult,
    emitCompletionNotification: args.emitCompletionNotification,
    claimsParentRuntime: args.claimsParentRuntime,
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
        if (
          target &&
          (target.type === "claude-code" || target.type === "codex")
        ) {
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
  taskId?: string;
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
  const taskId = args.taskId ?? getNextTaskId();
  return spawnBackgroundSubagentTask({
    taskId,
    subagentType: target.type,
    config: createExternalCodingAgentConfig(target.type),
    prompt: args.message,
    description: `Continue ${target.type} session`,
    parentScope: args.parentScope,
    actingUserId: args.parentScope.actingUserId,
    deps: {
      spawnSubagentImpl: async (_type, prompt, _model, subagentId, signal) =>
        runExternalCodingAgent({
          type: target.type,
          taskId,
          prompt,
          parentAgentId: args.parentScope.agentId,
          parentConversationId: args.parentScope.conversationId,
          actingUserId: args.parentScope.actingUserId,
          resumeSessionId: target.sessionId,
          cwd: getCurrentWorkingDirectory(),
          signal,
          ...externalWorkerProgressListeners(subagentId),
        }),
    },
  });
}
