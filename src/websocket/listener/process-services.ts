import {
  getSubagents,
  subscribe as subscribeToSubagentState,
  subscribeToStreamEvents as subscribeToSubagentStreamEvents,
} from "@/agent/subagent-state";
import { stopScheduler as stopCronScheduler } from "@/cron/scheduler";
import {
  deliverDiskSpaceReminder,
  watchSandboxDiskSpace,
} from "@/reminders/disk-space";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { subscribeToBackgroundProcessState } from "@/tools/impl/process_manager";
import { setMessageQueueAdder } from "@/utils/message-queue-bridge";
import { TO_SUBSCRIBERS } from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  emitDeviceStatusIfOpen,
  emitProtocolV2Message,
  emitStreamDelta,
  emitSubagentStateIfOpen,
} from "./protocol-outbound";
import { scheduleQueuePump } from "./queue";
import { clearRuntimeTimers, getActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import { isListenerTransportOpen } from "./transport";
import type {
  ConversationRuntime,
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
      if (event.type === "memory_updated") {
        if (subagent?.parentAgentId) {
          emitProtocolV2Message(
            processTransport,
            runtime,
            event,
            {
              agent_id: subagent.parentAgentId,
              conversation_id: subagent.parentConversationId ?? "default",
            },
            TO_SUBSCRIBERS,
          );
        }
        return;
      }
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

  runtime._unsubscribeBackgroundProcessState?.();
  runtime._unsubscribeBackgroundProcessState =
    subscribeToBackgroundProcessState((scope) => {
      if (scope) {
        emitDeviceStatusIfOpen(runtime, {
          agent_id: scope.agentId,
          conversation_id: scope.conversationId,
        });
        return;
      }
      if (runtime.conversationRuntimes.size === 0) {
        emitDeviceStatusIfOpen(runtime);
        return;
      }
      for (const conversationRuntime of runtime.conversationRuntimes.values()) {
        emitDeviceStatusIfOpen(runtime, {
          agent_id: conversationRuntime.agentId,
          conversation_id: conversationRuntime.conversationId,
        });
      }
    });

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
      content: queuedMessage.content,
      actingUserId: queuedMessage.actingUserId,
      agentId: queuedMessage.agentId ?? targetRuntime.agentId ?? undefined,
      conversationId:
        queuedMessage.conversationId ?? targetRuntime.conversationId,
    } as Omit<
      import("@/queue/queue-runtime").TaskNotificationQueueItem,
      "id" | "enqueuedAt"
    >);
    scheduleQueuePump(targetRuntime, processTransport, opts, processQueuedTurn);
  });

  // One disk watcher per sandbox. Alert only the most recently active
  // conversation so idle agents don't all wake to free space at once; the
  // rest see the between-turns reminder on their next turn.
  runtime._stopDiskSpaceWatch?.();
  runtime._stopDiskSpaceWatch = watchSandboxDiskSpace(
    getCurrentWorkingDirectory,
    (text) => deliverSandboxDiskAlert(runtime, text),
  );
}

export function deliverSandboxDiskAlert(
  runtime: ListenerRuntime,
  text: string,
): void {
  const target = getMostRecentlyActiveConversation(runtime);
  deliverDiskSpaceReminder(
    text,
    target?.agentId
      ? { agentId: target.agentId, conversationId: target.conversationId }
      : undefined,
  );
}

/** A running turn counts as now; otherwise the last model response time. */
function getMostRecentlyActiveConversation(
  runtime: ListenerRuntime,
): ConversationRuntime | null {
  let latest: ConversationRuntime | null = null;
  let latestAt = -1;
  for (const conversationRuntime of runtime.conversationRuntimes.values()) {
    if (!conversationRuntime.agentId) continue;
    const activeAt = conversationRuntime.isProcessing
      ? Number.POSITIVE_INFINITY
      : (conversationRuntime.contextTracker.contextTokensHistory.at(-1)
          ?.timestamp ?? 0);
    if (activeAt > latestAt) {
      latest = conversationRuntime;
      latestAt = activeAt;
    }
  }
  return latest;
}

export function clearProcessServices(runtime: ListenerRuntime): void {
  runtime._unsubscribeSubagentState?.();
  runtime._unsubscribeSubagentState = undefined;
  runtime._unsubscribeSubagentStreamEvents?.();
  runtime._unsubscribeSubagentStreamEvents = undefined;
  runtime._unsubscribeBackgroundProcessState?.();
  runtime._unsubscribeBackgroundProcessState = undefined;
  runtime._stopDiskSpaceWatch?.();
  runtime._stopDiskSpaceWatch = undefined;
  setMessageQueueAdder(null);
  stopCronScheduler();
  clearRuntimeTimers(runtime);
  runtime.processServicesStarted = false;
}

export function invalidateProcessServices(runtime: ListenerRuntime): void {
  runtime.processServicesGeneration += 1;
  clearProcessServices(runtime);
}

export async function waitForProcessServicesSlot(
  runtime: ListenerRuntime,
  connectionId: string,
): Promise<boolean> {
  const initiatingConnection = runtime.connections.get(connectionId);
  const canInitiate = () =>
    !initiatingConnection ||
    (runtime.connections.get(connectionId) === initiatingConnection &&
      !initiatingConnection.cancellation.signal.aborted);

  while (runtime.processServicesReady) {
    const pending = runtime.processServicesReady;
    const pendingGeneration = runtime.processServicesReadyGeneration;
    try {
      await pending;
    } catch (error) {
      if (pendingGeneration === runtime.processServicesGeneration) throw error;
    }
    if (runtime.processServicesStarted) return false;
    if (
      runtime !== getActiveRuntime() ||
      runtime.intentionallyClosed ||
      !canInitiate()
    ) {
      return false;
    }
  }
  return canInitiate();
}
