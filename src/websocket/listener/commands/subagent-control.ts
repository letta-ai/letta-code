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
import {
  type NativeSessionCaptureReservation,
  reportNativeSessionCaptureFailure,
  reserveNativeSessionCapture,
} from "@/tools/impl/native-session-capture";
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

function dedupeKey(command: SubagentMessageCommand): string {
  return JSON.stringify([
    command.runtime.agent_id,
    command.runtime.conversation_id,
    command.agent_id,
    command.request_id,
  ]);
}

function finishUntrackedNativeCapture(
  completion: Promise<unknown>,
  reservation: NativeSessionCaptureReservation | undefined,
  source: "claude_code" | "codex",
  sessionId: string,
): void {
  if (!reservation) return;
  void completion
    .then(
      () => reservation.capture(),
      () => reservation.capture(),
    )
    .catch((error) =>
      reportNativeSessionCaptureFailure(source, sessionId, error),
    );
}

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
    bundledSkills: parent.bundledSkills,
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
    reserveCapture?: typeof reserveNativeSessionCapture;
    now?: () => number;
  } = {},
): Promise<SubagentMessageResponse> {
  const now = (deps.now ?? Date.now)();
  const key = dedupeKey(command);
  for (const [id, cached] of responses) {
    if (cached.expiresAt <= now) responses.delete(id);
  }
  const cached = responses.get(key);
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
      if (!target.sessionId)
        throw new Error("External coding agent ID has no session ID");
      const sessionId = target.sessionId;
      if (target.type === "opencode")
        throw new Error("Remote OpenCode steering is not supported");

      let captureReservation: NativeSessionCaptureReservation | undefined;
      const source = target.type === "claude-code" ? "claude_code" : "codex";
      const receipt = await runOutsideRuntimeContext(() =>
        runWithRuntimeContext(runtimeContext(parent, command), () =>
          target.type === "claude-code"
            ? (deps.sendClaude ?? sendClaudeMessage)({
                sessionId: target.sessionId,
                prompt: command.message,
                parentAgentId: command.runtime.agent_id,
                cwd: getCurrentWorkingDirectory(),
                beforeStart: async () => {
                  captureReservation = await (
                    deps.reserveCapture ?? reserveNativeSessionCapture
                  )(source, sessionId, {
                    agentId: command.runtime.agent_id,
                    conversationId: command.runtime.conversation_id,
                    actingUserId: command.runtime.acting_user_id,
                  });
                },
              })
            : (deps.sendCodex ?? sendCodexMessage)({
                threadId: target.sessionId,
                prompt: command.message,
                parentAgentId: command.runtime.agent_id,
                cwd: getCurrentWorkingDirectory(),
                beforeStart: async () => {
                  captureReservation = await (
                    deps.reserveCapture ?? reserveNativeSessionCapture
                  )(source, sessionId, {
                    agentId: command.runtime.agent_id,
                    conversationId: command.runtime.conversation_id,
                    actingUserId: command.runtime.acting_user_id,
                  });
                },
              }),
        ),
      );
      if (receipt.mode === "steered")
        return { ...base, success: true, delivery: "steered" };
      if (!receipt.completion || !receipt.interrupt)
        throw new Error("External coding agent returned an incomplete receipt");
      try {
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
          captureReservation,
          toolCallId: command.tool_call_id,
          // This handler always runs on the worker, for a parent runtime that
          // only exists here as a sideband control scope. Mirror the
          // `notify: "caller"` launch contract: publish the result back to the
          // caller and let its own listener raise the notice. Emitting it here
          // would start a turn on the caller's conversation from the worker's
          // machine, and claiming the runtime would make Cloud route the
          // caller's deliveries to this sandbox.
          publishResult: true,
          emitCompletionNotification: false,
          claimsParentRuntime: false,
        });
      } catch (error) {
        await receipt.interrupt().catch(() => undefined);
        finishUntrackedNativeCapture(
          receipt.completion,
          captureReservation,
          source,
          sessionId,
        );
        throw error;
      }
      return { ...base, success: true, delivery: "resumed" };
    } catch (error) {
      return {
        ...base,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })();
  responses.set(key, {
    expiresAt: now + DEDUPE_TTL_MS,
    response,
  });
  const result = await response;
  if (!result.success && responses.get(key)?.response === response)
    responses.delete(key);
  return result;
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
