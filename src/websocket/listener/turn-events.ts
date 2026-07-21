import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  ReflectionSettings,
  ReflectionTrigger,
} from "@/cli/helpers/memory-reminder";
import {
  AUTO_REFLECTION_DESCRIPTION,
  launchReflectionSubagent,
} from "@/cli/helpers/reflection-launcher";
import { getTurnStartCancel } from "@/mods/turn-start-cancel";
import { settingsManager } from "@/settings-manager";
import { getListenerTelemetrySurface } from "@/telemetry";
import type { StreamDelta } from "@/types/protocol_v2";
import {
  createListenerModContext,
  createListenerModEvents,
  ensureListenerModAdaptersForAgent,
} from "./mod-adapter";
import { emitCanonicalMessageDelta } from "./protocol-outbound";
import type { ListenerTransport } from "./transport";
import type { ConversationRuntime, ListenerRuntime } from "./types";

export function escapeTaskNotificationSummary(summary: string): string {
  return summary
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isTurnInputArray(
  value: unknown,
): value is Array<MessageCreate | ApprovalCreate> {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "object" && item !== null)
  );
}

export type ListenerTurnStartEmission =
  | { cancelled: false; input: Array<MessageCreate | ApprovalCreate> }
  | { cancelled: true; reason: string };

export async function emitListenerTurnStart(options: {
  agentId: string;
  conversationId: string;
  input: Array<MessageCreate | ApprovalCreate>;
  runtime: ListenerRuntime;
  workingDirectory: string;
  permissionMode?: string | null;
  cachedAgent?: AgentState | null;
}): Promise<ListenerTurnStartEmission> {
  try {
    const modAdapters = await ensureListenerModAdaptersForAgent(
      options.runtime,
      options.agentId,
    );
    const context = createListenerModContext({
      sessionId: options.conversationId,
      workingDirectory: options.workingDirectory,
      permissionMode: options.permissionMode ?? null,
      agent: options.cachedAgent ?? null,
    });
    const event = {
      agentId: options.agentId,
      conversationId: options.conversationId,
      input: options.input,
    };
    await createListenerModEvents(modAdapters).emit(
      "turn_start",
      event,
      context,
    );
    const cancel = getTurnStartCancel(event);
    if (cancel) {
      return { cancelled: true, reason: cancel.reason };
    }
    return {
      cancelled: false,
      input: isTurnInputArray(event.input) ? event.input : options.input,
    };
  } catch {
    // Mod turn_start handlers should not block sending the turn.
    return { cancelled: false, input: options.input };
  }
}

export async function emitListenerTurnEnd(options: {
  agentId: string;
  conversationId: string;
  stopReason: string;
  assistantMessage?: string;
  runtime: ListenerRuntime;
  workingDirectory: string;
  permissionMode?: string | null;
  cachedAgent?: AgentState | null;
}): Promise<string | undefined> {
  try {
    const modAdapters = await ensureListenerModAdaptersForAgent(
      options.runtime,
      options.agentId,
    );
    const context = createListenerModContext({
      sessionId: options.conversationId,
      workingDirectory: options.workingDirectory,
      permissionMode: options.permissionMode ?? null,
      agent: options.cachedAgent ?? null,
    });
    const event: {
      agentId: string;
      conversationId: string;
      stopReason: string;
      assistantMessage?: string;
      continue?: string;
    } = {
      agentId: options.agentId,
      conversationId: options.conversationId,
      stopReason: options.stopReason,
      assistantMessage: options.assistantMessage,
    };
    await createListenerModEvents(modAdapters).emit("turn_end", event, context);
    return typeof event.continue === "string" && event.continue.length > 0
      ? event.continue
      : undefined;
  } catch {
    // Mod turn_end handlers should not block turn completion.
    return undefined;
  }
}

export function buildMaybeLaunchReflectionSubagent(params: {
  runtime: ConversationRuntime;
  socket: ListenerTransport;
  agentId: string;
  conversationId: string;
  reflectionSettings?: ReflectionSettings;
  cachedAgent?: AgentState | null;
}): (triggerSource: Exclude<ReflectionTrigger, "off">) => Promise<boolean> {
  return async (triggerSource) => {
    const {
      runtime,
      socket,
      agentId,
      conversationId,
      reflectionSettings,
      cachedAgent,
    } = params;

    if (!agentId) {
      return false;
    }

    const result = await launchReflectionSubagent({
      agentId,
      conversationId,
      memfsEnabled: settingsManager.isMemfsEnabled(agentId),
      triggerSource,
      skipPendingWorktreeReminderScan: triggerSource === "compaction-event",
      reflectionSettings,
      description: AUTO_REFLECTION_DESCRIPTION,
      systemPrompt: cachedAgent?.system ?? undefined,
      recompileByConversation:
        runtime.listener.systemPromptRecompileByConversation,
      recompileQueuedByConversation:
        runtime.listener.queuedSystemPromptRecompileByConversation,
      feedbackContext: {
        surface: getListenerTelemetrySurface(),
      },
      onCompletionMessage: async (completionMessage, reflectionResult) => {
        const reflectionAgentIdTag = reflectionResult.reflectionAgentId
          ? `<reflection-agent-id>${escapeTaskNotificationSummary(
              reflectionResult.reflectionAgentId,
            )}</reflection-agent-id>`
          : "";
        const notificationXml = `<task-notification><summary>${escapeTaskNotificationSummary(
          completionMessage,
        )}</summary>${reflectionAgentIdTag}</task-notification>`;
        emitCanonicalMessageDelta(
          socket,
          runtime,
          {
            type: "message",
            id: `user-msg-${crypto.randomUUID()}`,
            date: new Date().toISOString(),
            message_type: "user_message",
            content: [{ type: "text", text: notificationXml }],
          } as StreamDelta,
          {
            agent_id: agentId,
            conversation_id: conversationId,
          },
        );
      },
    });
    return result.launched;
  };
}
