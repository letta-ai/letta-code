import { type QueueItem, QueueRuntime } from "@/queue/queue-runtime";
import type { QueueRemovalTransition } from "@/types/queue-update-protocol";
import { enqueueInboundUserMessage } from "./inbound-queue";
import {
  forgetQueuedInputDispositions,
  loadDurableQueuedInputs,
  markQueuedInputDispositionsStarted,
  ordinaryInputIdentity,
} from "./input-disposition";
import {
  clearPreparedInputTerminalByTurnId,
  loadPreparedInputTerminals,
} from "./input-terminal-journal";
import { getQueueItemScope, getQueueItemsScope } from "./queue";
import { scheduleQueueEmit } from "./queue-update-outbound";
import {
  evictConversationRuntimeIfIdle,
  getOrCreateConversationRuntime,
} from "./runtime";
import { createTurnFinishedStore } from "./turn-finished-replay";
import type { ConversationRuntime, ListenerRuntime } from "./types";

function discardQueuedItem(
  runtime: ConversationRuntime,
  item: QueueItem,
): void {
  runtime.queuedMessagesByItemId.delete(item.id);
}

function itemIdentities(
  runtime: ConversationRuntime,
  items: readonly QueueItem[],
) {
  return items.flatMap((item) => {
    const identities = runtime.queuedMessagesByItemId.get(
      item.id,
    )?.durableInputIdentities;
    if (identities?.length) return [...identities];
    const fallback = ordinaryInputIdentity(item.clientMessageId);
    return fallback ? [fallback] : [];
  });
}

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
      beforeDequeued: (items) =>
        markQueuedInputDispositionsStarted(
          runtime,
          itemIdentities(runtime, items),
        ),
      beforeDropped: (item) =>
        forgetQueuedInputDispositions(runtime, itemIdentities(runtime, [item])),
      beforeRemoved: (item) =>
        forgetQueuedInputDispositions(runtime, itemIdentities(runtime, [item])),
      beforeCleared: (reason, items) =>
        reason === "shutdown" ||
        forgetQueuedInputDispositions(runtime, itemIdentities(runtime, items)),
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
      onPauseChanged: () => {
        // Paused flags ride on the update_queue snapshot.
        scheduleQueueEmit(listener, {
          agent_id: runtime.agentId,
          conversation_id: runtime.conversationId,
        });
      },
      onCleared: (reason, _clearedCount, items) => {
        runtime.pendingTurns = 0;
        // Runtime replacement clears volatile queues but deliberately retains
        // durable payloads for the successor process to restore.
        if (reason === "shutdown") {
          for (const item of items) {
            runtime.queuedMessagesByItemId.delete(item.id);
          }
        } else {
          for (const item of items) discardQueuedItem(runtime, item);
        }
        scheduleQueueEmit(
          listener,
          getQueueItemsScope(items),
          items.map((item) => queueRemovalTransition(item, "cancelled")),
        );
        evictConversationRuntimeIfIdle(runtime);
      },
      onDropped: (item, _reason, queueLen) => {
        runtime.pendingTurns = queueLen;
        discardQueuedItem(runtime, item);
        scheduleQueueEmit(listener, getQueueItemScope(item), [
          queueRemovalTransition(item, "cancelled"),
        ]);
        evictConversationRuntimeIfIdle(runtime);
      },
      onRemoved: (item, queueLen) => {
        runtime.pendingTurns = queueLen;
        discardQueuedItem(runtime, item);
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

/**
 * Rehydrate every durable queued input before startup schedules its first queue
 * pump. Existing volatile items win during same-process graceful replacement;
 * their stable client id prevents a second queue item from being inserted.
 */
export function restoreDurableQueuedInputs(
  listener: ListenerRuntime,
  terminalStore = createTurnFinishedStore(),
): number {
  promotePreparedInputTerminals(listener, terminalStore);
  let restored = 0;
  for (const payload of loadDurableQueuedInputs(listener)) {
    const runtime = getOrCreateScopedRuntime(
      listener,
      payload.scope.agentId,
      payload.scope.conversationId,
    );
    const alreadyRestored = [...runtime.queuedMessagesByItemId.values()].some(
      (incoming) =>
        incoming.durableInputIdentities?.some(
          (identity) =>
            identity.domain === payload.identity.domain &&
            identity.id === payload.identity.id,
        ) ||
        (payload.identity.domain === "input" &&
          ordinaryInputIdentity(
            incoming.messages.flatMap((message) => {
              if (!("content" in message)) return [];
              const id = (message as { client_message_id?: unknown })
                .client_message_id;
              return typeof id === "string" ? [id] : [];
            })[0],
          )?.id === payload.identity.id),
    );
    if (alreadyRestored) continue;
    // A dead connection id cannot own restored work. The process transport and
    // current scope subscriber become the delivery path after startup. Preserve
    // the explicit identity so teleport payloads never enter the ordinary id domain.
    const incoming = {
      ...payload.incoming,
      connectionId: undefined,
      durableInputIdentities: [payload.identity],
    };
    if (!enqueueInboundUserMessage(runtime, incoming, payload.actingUserId)) {
      throw new Error("Durable queued input exceeded runtime queue capacity");
    }
    restored += 1;
  }
  return restored;
}

/** Promote terminal journals before connection state-sync attempts replay. */
export function promotePreparedInputTerminals(
  listener: ListenerRuntime,
  terminalStore = createTurnFinishedStore(),
): void {
  for (const prepared of loadPreparedInputTerminals(listener)) {
    if (prepared.message.terminal_consumer_ids?.length) {
      terminalStore.put(
        prepared.scope.agentId,
        prepared.scope.conversationId,
        prepared.message,
        prepared.owner,
      );
    }
    if (
      !clearPreparedInputTerminalByTurnId(listener, prepared.message.turn_id)
    ) {
      throw new Error("Failed to promote prepared input terminal");
    }
  }
}
