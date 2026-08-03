import { type QueueItem, QueueRuntime } from "@/queue/queue-runtime";
import { markRuntimeInputsDropped } from "./input-state";
import { scheduleQueueEmit } from "./protocol-outbound";
import {
  getQueueItemClientMessageIds,
  getQueueItemScope,
  getQueueItemsScope,
} from "./queue";
import {
  evictConversationRuntimeIfIdle,
  getOrCreateConversationRuntime,
} from "./runtime";
import type { ConversationRuntime, ListenerRuntime } from "./types";

function settleDiscardedQueueItem(
  listener: ListenerRuntime,
  runtime: ConversationRuntime,
  item: QueueItem,
  reason: string,
  queueLen: number,
): void {
  runtime.pendingTurns = queueLen;
  markRuntimeInputsDropped(
    runtime,
    getQueueItemClientMessageIds(runtime, item),
    reason,
  );
  runtime.queuedMessagesByItemId.delete(item.id);
  scheduleQueueEmit(listener, getQueueItemScope(item));
  evictConversationRuntimeIfIdle(runtime);
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
          items.flatMap((item) => getQueueItemClientMessageIds(runtime, item)),
          `Listener queue cleared: ${reason}`,
        );
        for (const item of items) {
          runtime.queuedMessagesByItemId.delete(item.id);
        }
        scheduleQueueEmit(listener, getQueueItemsScope(items));
        evictConversationRuntimeIfIdle(runtime);
      },
      onDropped: (item, reason, queueLen) => {
        settleDiscardedQueueItem(listener, runtime, item, reason, queueLen);
      },
      onRemoved: (item, queueLen) => {
        settleDiscardedQueueItem(listener, runtime, item, "removed", queueLen);
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
