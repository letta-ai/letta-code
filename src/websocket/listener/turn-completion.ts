import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { regenerateConversationDescription } from "@/agent/conversation-description";
import type { Line } from "@/cli/helpers/accumulator";
import { getReflectionSettings } from "@/cli/helpers/memory-reminder";
import { maybeLaunchPostTurnReflection } from "@/cli/helpers/post-turn-reflection";
import { queuePendingReflectionWorktreeReminders } from "@/cli/helpers/reflection-launcher";
import { appendTranscriptDeltaJsonl } from "@/cli/helpers/reflection-transcript";
import { settingsManager } from "@/settings-manager";
import { debugWarn } from "@/utils/debug";
import type { ListenerTransport } from "./transport";
import {
  buildMaybeLaunchReflectionSubagent,
  emitListenerTurnEnd,
} from "./turn-events";
import type { ConversationRuntime } from "./types";

export async function completeSuccessfulListenerTurn(params: {
  runtime: ConversationRuntime;
  socket: ListenerTransport;
  agentId: string;
  conversationId: string;
  workingDirectory: string;
  permissionMode: string;
  actingUserId?: string;
  assistantMessage?: string;
  transcriptLines: Line[];
  getCachedAgent: () => AgentState | null;
  isInterrupted: () => boolean;
}): Promise<"completed" | "interrupted"> {
  const continueText = await emitListenerTurnEnd({
    agentId: params.agentId,
    conversationId: params.conversationId,
    stopReason: "end_turn",
    assistantMessage: params.assistantMessage,
    runtime: params.runtime.listener,
    workingDirectory: params.workingDirectory,
    permissionMode: params.permissionMode,
    cachedAgent: params.getCachedAgent(),
  });
  if (params.isInterrupted()) {
    return "interrupted";
  }

  if (continueText) {
    params.runtime.queueRuntime.enqueue({
      kind: "mod_continue",
      source: "system",
      text: continueText,
      agentId: params.agentId,
      conversationId: params.conversationId,
      actingUserId: params.actingUserId,
    } as Omit<
      import("@/queue/queue-runtime").ModContinueQueueItem,
      "id" | "enqueuedAt"
    >);
  }

  try {
    if (params.transcriptLines.length > 0) {
      await appendTranscriptDeltaJsonl(
        params.agentId,
        params.conversationId,
        params.transcriptLines,
      );
    }
  } catch (error) {
    debugWarn(
      "memory",
      `Failed to append transcript delta: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (params.isInterrupted()) {
    return "interrupted";
  }

  try {
    const reflectionSettings = getReflectionSettings(
      params.agentId,
      params.workingDirectory,
    );
    await maybeLaunchPostTurnReflection({
      agentId: params.agentId,
      conversationId: params.conversationId,
      memfsEnabled: settingsManager.isMemfsEnabled(params.agentId),
      reflectionSettings,
      reminderState: params.runtime.reminderState,
      contextTracker: params.runtime.contextTracker,
      onCompaction: () =>
        queuePendingReflectionWorktreeReminders({
          agentId: params.agentId,
          conversationId: params.conversationId,
        }),
      launch: buildMaybeLaunchReflectionSubagent({
        runtime: params.runtime,
        socket: params.socket,
        agentId: params.agentId,
        conversationId: params.conversationId,
        reflectionSettings,
        cachedAgent: params.getCachedAgent(),
      }),
    });
  } catch (error) {
    debugWarn(
      "memory",
      `Failed to evaluate post-turn channel reflection: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (params.isInterrupted()) {
    return "interrupted";
  }

  if (
    params.runtime.contextTracker.pendingConversationDescriptionRegeneration
  ) {
    params.runtime.contextTracker.pendingConversationDescriptionRegeneration = false;
    void regenerateConversationDescription(params.conversationId);
  }
  return "completed";
}
