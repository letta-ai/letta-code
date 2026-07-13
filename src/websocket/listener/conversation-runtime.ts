import { QueueRuntime } from "@/queue/queue-runtime";
import { scheduleQueueEmit } from "./protocol-outbound";
import {
  getQueueItemScope,
  getQueueItemsScope,
  recordCronQueueLifecycleForItems,
} from "./queue";
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
      onCleared: (reason, clearedCount, items) => {
        runtime.pendingTurns = 0;
        recordCronQueueLifecycleForItems(items, {
          action: "cleared",
          status: "skipped",
          clearedReason: reason,
          clearedCount,
          queueLenAfter: 0,
        });
        scheduleQueueEmit(listener, getQueueItemsScope(items));
        evictConversationRuntimeIfIdle(runtime);
      },
      onDropped: (item, reason, queueLen) => {
        runtime.pendingTurns = queueLen;
        runtime.queuedMessagesByItemId.delete(item.id);
        recordCronQueueLifecycleForItems([item], {
          action: "dropped",
          status: "skipped",
          droppedReason: reason,
          queueLen,
        });
        scheduleQueueEmit(listener, getQueueItemScope(item));
        evictConversationRuntimeIfIdle(runtime);
      },
      onRemoved: (item, queueLen) => {
        runtime.pendingTurns = queueLen;
        runtime.queuedMessagesByItemId.delete(item.id);
        recordCronQueueLifecycleForItems([item], {
          action: "removed",
          status: "skipped",
          removedReason: "explicit_remove",
          queueLen,
        });
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

/**
 * Fallback for unscoped task notifications (e.g., reflection/init spawned
 * outside turn processing). Picks the first ConversationRuntime that has a
 * QueueRuntime, or null if none exist.
 */
export function findFallbackRuntime(
  listener: ListenerRuntime,
): ConversationRuntime | null {
  for (const cr of listener.conversationRuntimes.values()) {
    if (cr.queueRuntime) {
      return cr;
    }
  }
  return null;
}
