import {
  getSubagents,
  subscribe as subscribeToSubagentState,
  subscribeToStreamEvents as subscribeToSubagentStreamEvents,
} from "@/agent/subagent-state";
import { setMessageQueueAdder } from "@/utils/message-queue-bridge";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { emitStreamDelta, emitSubagentStateIfOpen } from "./protocol-outbound";
import { scheduleQueuePump } from "./queue";
import type { ListenerTransport } from "./transport";
import { isListenerTransportOpen } from "./transport";
import type {
  ListenerRuntime,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "./types";

export function installProcessEventRouting(params: {
  runtime: ListenerRuntime;
  processTransport: ListenerTransport;
  opts: StartListenerOptions;
  processQueuedTurn: ProcessQueuedTurn;
}): void {
  const { runtime, processTransport, opts, processQueuedTurn } = params;
  runtime._unsubscribeSubagentState?.();
  runtime._unsubscribeSubagentState = subscribeToSubagentState(() => {
    if (runtime.conversationRuntimes.size === 0) {
      emitSubagentStateIfOpen(runtime);
      return;
    }
    for (const conversationRuntime of runtime.conversationRuntimes.values()) {
      emitSubagentStateIfOpen(runtime, {
        agent_id: conversationRuntime.agentId,
        conversation_id: conversationRuntime.conversationId,
      });
    }
  });

  runtime._unsubscribeSubagentStreamEvents?.();
  runtime._unsubscribeSubagentStreamEvents = subscribeToSubagentStreamEvents(
    (subagentId, event) => {
      if (!isListenerTransportOpen(processTransport)) return;
      const subagent = getSubagents().find((entry) => entry.id === subagentId);
      if (subagent?.silent === true) return;

      emitStreamDelta(
        processTransport,
        runtime,
        event as unknown as import("@/types/protocol_v2").StreamDelta,
        subagent?.parentAgentId
          ? {
              agent_id: subagent.parentAgentId,
              conversation_id: subagent.parentConversationId ?? "default",
            }
          : undefined,
        subagentId,
      );
    },
  );

  setMessageQueueAdder((queuedMessage) => {
    if (!queuedMessage.agentId || !queuedMessage.conversationId) return;
    const targetRuntime = getOrCreateScopedRuntime(
      runtime,
      queuedMessage.agentId,
      queuedMessage.conversationId,
    );
    if (!targetRuntime?.queueRuntime) return;

    targetRuntime.queueRuntime.enqueue({
      kind: "task_notification",
      source: "task_notification",
      text: queuedMessage.text,
      agentId: queuedMessage.agentId ?? targetRuntime.agentId ?? undefined,
      conversationId:
        queuedMessage.conversationId ?? targetRuntime.conversationId,
    } as Omit<
      import("@/queue/queue-runtime").TaskNotificationQueueItem,
      "id" | "enqueuedAt"
    >);
    scheduleQueuePump(targetRuntime, processTransport, opts, processQueuedTurn);
  });
}
