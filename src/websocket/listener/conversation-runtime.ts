import { type QueueItem, QueueRuntime } from "@/queue/queue-runtime";
import type { QueueRemovalTransition } from "@/types/queue-update-protocol";
import { getQueueItemScope, getQueueItemsScope } from "./queue";
import { scheduleQueueEmit } from "./queue-update-outbound";
import {
  evictConversationRuntimeIfIdle,
  getOrCreateConversationRuntime,
} from "./runtime";
import type { ConversationRuntime, ListenerRuntime } from "./types";

function queueRemovalTransition(
  item: QueueItem,
  disposition: QueueRemovalTransition["disposition"],
): QueueRemovalTransition {
  return {
    client_message_id: item.clientMessageId ?? `cm-${item.id}`,
    disposition,
  };
}

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
        scheduleQueueEmit(
          listener,
          getQueueItemsScope(batch.items),
          batch.items.map((item) => queueRemovalTransition(item, "dequeued")),
        );
      },
      onBlocked: () => {
        scheduleQueueEmit(listener, {
          agent_id: runtime.agentId,
          conversation_id: runtime.conversationId,
        });
      },
      onCleared: (_reason, _clearedCount, items) => {
        runtime.pendingTurns = 0;
        scheduleQueueEmit(
          listener,
          getQueueItemsScope(items),
          items.map((item) => queueRemovalTransition(item, "cancelled")),
        );
        evictConversationRuntimeIfIdle(runtime);
      },
      onDropped: (item, _reason, queueLen) => {
        runtime.pendingTurns = queueLen;
        runtime.queuedMessagesByItemId.delete(item.id);
        scheduleQueueEmit(listener, getQueueItemScope(item), [
          queueRemovalTransition(item, "cancelled"),
        ]);
        evictConversationRuntimeIfIdle(runtime);
      },
      onRemoved: (item, queueLen) => {
        runtime.pendingTurns = queueLen;
        runtime.queuedMessagesByItemId.delete(item.id);
        scheduleQueueEmit(listener, getQueueItemScope(item), [
          queueRemovalTransition(item, "cancelled"),
        ]);
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
