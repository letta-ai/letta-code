import { getSubagents } from "@/agent/subagent-state";
import {
  getCurrentWorkingDirectory,
  runOutsideRuntimeContext,
  runWithRuntimeContext,
} from "@/runtime-context";
import { sendClaudeMessage } from "@/tools/impl/claude-stream-session";
import { sendCodexMessage } from "@/tools/impl/codex-app-server";
import {
  isExternalCodingAgentType,
  parseExternalCodingAgentId,
} from "@/tools/impl/external-coding-agent";
import { trackExternalFollowupCompletion } from "@/tools/impl/external-coding-agent-task";
import { backgroundTasks } from "@/tools/impl/process_manager";
import type {
  SubagentMessageCommand,
  SubagentMessageResponse,
  SubagentStopCommand,
  SubagentStopResponse,
} from "@/types/subagent-protocol";
import { getConversationWorkingDirectory } from "@/websocket/listener/cwd";
import type { ConversationRuntime } from "@/websocket/listener/types";

const DEDUPE_TTL_MS = 30_000;
const responses = new Map<
  string,
  { expiresAt: number; response: Promise<SubagentMessageResponse> }
>();

function findOwnedTask(runtime: ConversationRuntime, agentId: string) {
  const subagent = getSubagents().find(
    (entry) =>
      entry.agentId === agentId &&
      entry.parentAgentId === runtime.agentId &&
      entry.parentConversationId === runtime.conversationId,
  );
  if (!subagent) return undefined;
  return [...backgroundTasks.entries()].find(
    ([, task]) => task.subagentId === subagent.id,
  );
}

function runtimeContext(
  parent: ConversationRuntime,
  command: SubagentMessageCommand,
) {
  return {
    agentId: parent.agentId,
    conversationId: parent.conversationId,
    actingUserId: command.runtime.acting_user_id,
    workingDirectory: getConversationWorkingDirectory(
      parent.listener,
      parent.agentId,
      parent.conversationId,
    ),
    skillSources: parent.skillSources,
    workspaceSandbox: parent.workspaceSandbox,
    executionSettings: parent.executionSettings,
  };
}

export async function handleSubagentMessageCommand(
  command: SubagentMessageCommand,
  parent: ConversationRuntime,
  deps: {
    sendClaude?: typeof sendClaudeMessage;
    sendCodex?: typeof sendCodexMessage;
    track?: typeof trackExternalFollowupCompletion;
    now?: () => number;
  } = {},
): Promise<SubagentMessageResponse> {
  const now = (deps.now ?? Date.now)();
  for (const [id, cached] of responses) {
    if (cached.expiresAt <= now) responses.delete(id);
  }
  const cached = responses.get(command.request_id);
  if (cached) return cached.response;

  const response = (async (): Promise<SubagentMessageResponse> => {
    const base = {
      type: "subagent_message_response" as const,
      request_id: command.request_id,
      runtime: command.runtime,
    };
    try {
      if (
        parent.agentId !== command.runtime.agent_id ||
        parent.conversationId !== command.runtime.conversation_id
      )
        throw new Error("Parent runtime does not match the message request");
      if (!findOwnedTask(parent, command.agent_id))
        throw new Error("Subagent does not belong to this conversation");
      const target = parseExternalCodingAgentId(command.agent_id);
      if (!target || target.computer || !isExternalCodingAgentType(target.type))
        throw new Error("Invalid external coding agent ID");
      if (target.type === "opencode")
        throw new Error("Remote OpenCode steering is not supported");

      const receipt = await runOutsideRuntimeContext(() =>
        runWithRuntimeContext(runtimeContext(parent, command), () =>
          target.type === "claude-code"
            ? (deps.sendClaude ?? sendClaudeMessage)({
                sessionId: target.sessionId,
                prompt: command.message,
                parentAgentId: command.runtime.agent_id,
                cwd: getCurrentWorkingDirectory(),
              })
            : (deps.sendCodex ?? sendCodexMessage)({
                threadId: target.sessionId,
                prompt: command.message,
                parentAgentId: command.runtime.agent_id,
                cwd: getCurrentWorkingDirectory(),
              }),
        ),
      );
      if (receipt.mode === "steered")
        return { ...base, success: true, delivery: "steered" };
      if (!receipt.completion || !receipt.interrupt)
        throw new Error("External coding agent returned an incomplete receipt");
      (deps.track ?? trackExternalFollowupCompletion)({
        type: target.type,
        agentId: command.agent_id,
        message: command.message,
        parentScope: {
          agentId: parent.agentId,
          conversationId: parent.conversationId,
          actingUserId: command.runtime.acting_user_id,
        },
        completion: receipt.completion,
        interrupt: receipt.interrupt,
        toolCallId: command.tool_call_id,
        publishResult: true,
      });
      return { ...base, success: true, delivery: "resumed" };
    } catch (error) {
      return {
        ...base,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })();
  responses.set(command.request_id, {
    expiresAt: now + DEDUPE_TTL_MS,
    response,
  });
  return response;
}

export async function handleSubagentStopCommand(
  command: SubagentStopCommand,
  parent: ConversationRuntime,
): Promise<SubagentStopResponse> {
  const base: SubagentStopResponse = {
    type: "subagent_stop_response",
    request_id: command.request_id,
    runtime: command.runtime,
    agent_id: command.agent_id,
    success: false,
    stopped: false,
  };
  if (
    parent.agentId !== command.runtime.agent_id ||
    parent.conversationId !== command.runtime.conversation_id
  )
    return { ...base, error: "Parent runtime does not match the stop request" };
  const owned = findOwnedTask(parent, command.agent_id);
  if (!owned)
    return { ...base, error: "Subagent does not belong to this conversation" };
  const [, task] = owned;
  if (task.status !== "running") return { ...base, success: true };
  if (!task.abortController)
    return { ...base, error: "Subagent could not be stopped" };
  task.abortController.abort(new Error("Stopped by remote parent"));
  return { ...base, success: true, stopped: true };
}

export function __resetSubagentControlDedupeForTests(): void {
  responses.clear();
}
