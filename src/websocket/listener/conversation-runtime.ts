import { QueueRuntime } from "@/queue/queue-runtime";
import { markRuntimeInputsDropped } from "./input-state";
import { scheduleQueueEmit } from "./protocol-outbound";
import { getQueueItemScope, getQueueItemsScope } from "./queue";
import {
  evictConversationRuntimeIfIdle,
  getOrCreateConversationRuntime,
} from "./runtime";
import type { ConversationRuntime, ListenerRuntime } from "./types";

export function ensureConversationQueueRuntime(
  listener: ListenerRuntime,
  runtime: ConversationRuntime,
): ConversationRuntime {
  if (runtime.queueRuntime) {
    return runtime;
  }
  runtime.queueRuntime = new QueueRuntime({
    callbacks: {
      onEnqueued: (item, queueLen) => {
        runtime.pendingTurns = queueLen;
        scheduleQueueEmit(listener, getQueueItemScope(item));
      },
      onDequeued: (batch) => {
        runtime.pendingTurns = batch.queueLenAfter;
        scheduleQueueEmit(listener, getQueueItemsScope(batch.items));
      },
      onBlocked: () => {
        scheduleQueueEmit(listener, {
          agent_id: runtime.agentId,
          conversation_id: runtime.conversationId,
        });
      },
      onCleared: (reason, _clearedCount, items) => {
        runtime.pendingTurns = 0;
        markRuntimeInputsDropped(
          runtime,
          items.flatMap((item) =>
            item.kind === "message" && item.clientMessageId
              ? [item.clientMessageId]
              : [],
          ),
          `Listener queue cleared: ${reason}`,
        );
        scheduleQueueEmit(listener, getQueueItemsScope(items));
        evictConversationRuntimeIfIdle(runtime);
      },
      onDropped: (item, reason, queueLen) => {
        runtime.pendingTurns = queueLen;
        if (item.kind === "message" && item.clientMessageId) {
          markRuntimeInputsDropped(runtime, [item.clientMessageId], reason);
        }
        runtime.queuedMessagesByItemId.delete(item.id);
        scheduleQueueEmit(listener, getQueueItemScope(item));
        evictConversationRuntimeIfIdle(runtime);
      },
    },
  });
  return runtime;
}

export function getOrCreateScopedRuntime(
  listener: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): ConversationRuntime {
  return ensureConversationQueueRuntime(
    listener,
    getOrCreateConversationRuntime(listener, agentId, conversationId),
  );
}
