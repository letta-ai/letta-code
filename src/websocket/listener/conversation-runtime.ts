import { type QueueItem, QueueRuntime } from "@/queue/queue-runtime";
import type { QueueRemovalTransition } from "@/types/queue-update-protocol";
import { enqueueInboundUserMessage } from "./inbound-queue";
import {
  forgetQueuedInputDispositions,
  loadDurableQueuedInputEntries,
  markQueuedInputDispositionsStarted,
  ordinaryInputIdentity,
} from "./input-disposition";
import {
  clearPreparedInputTerminal,
  loadPreparedInputTerminals,
} from "./input-terminal-journal";
import {
  createInterruptedTurnStore,
  type InterruptedTurnRecord,
} from "./interrupted-turn-record";
import { getQueueItemScope, getQueueItemsScope } from "./queue";
import { scheduleQueueEmit } from "./queue-update-outbound";
import {
  evictConversationRuntimeIfIdle,
  getActiveRuntime,
  getOrCreateConversationRuntime,
} from "./runtime";
import { isListenerTransportOpen } from "./transport";
import {
  createTurnFinishedStore,
  replayPendingTurnFinishedToConnection,
  TurnFinishedCapacityError,
} from "./turn-finished-replay";
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

const DURABLE_QUEUE_RESTORE_RETRY_DELAY_MS = 10;
const DURABLE_QUEUE_RESTORE_MAX_RETRY_DELAY_MS = 250;

function durableQueueRestoreIsActive(listener: ListenerRuntime): boolean {
  return listener === getActiveRuntime() && !listener.intentionallyClosed;
}

function clearDurableQueueRestoreRetry(listener: ListenerRuntime): void {
  if (listener.durableQueueRestoreTimer) {
    clearTimeout(listener.durableQueueRestoreTimer);
    listener.durableQueueRestoreTimer = undefined;
  }
  listener.durableQueueRestoreFailures = 0;
}

export function scheduleDurableQueueRestore(
  listener: ListenerRuntime,
  capacityReleased = true,
): void {
  if (
    !durableQueueRestoreIsActive(listener) ||
    !listener.restoreDurableQueuedInputs
  ) {
    clearDurableQueueRestoreRetry(listener);
    listener.durableQueueRestoreScheduled = false;
    listener.durableQueueRestoreRerunRequested = false;
    return;
  }
  if (capacityReleased) clearDurableQueueRestoreRetry(listener);
  if (listener.durableQueueRestoreScheduled) {
    listener.durableQueueRestoreRerunRequested = true;
    return;
  }
  listener.durableQueueRestoreScheduled = true;
  queueMicrotask(() => {
    void (async () => {
      try {
        if (!durableQueueRestoreIsActive(listener)) {
          clearDurableQueueRestoreRetry(listener);
          return;
        }
        const result = listener.restoreDurableQueuedInputs?.();
        if (
          result &&
          typeof (result as unknown as PromiseLike<number>).then === "function"
        ) {
          await result;
        }
        clearDurableQueueRestoreRetry(listener);
      } catch {
        const failures = (listener.durableQueueRestoreFailures ?? 0) + 1;
        listener.durableQueueRestoreFailures = failures;
        if (!durableQueueRestoreIsActive(listener)) {
          clearDurableQueueRestoreRetry(listener);
          return;
        }
        // Accepted durable work must not depend on a future capacity callback.
        // Keep one coalesced wake alive for the lifetime of this runtime, with a
        // capped delay and exponent so a prolonged outage neither hot-loops nor
        // grows timers/state without bound.
        const delay = Math.min(
          DURABLE_QUEUE_RESTORE_MAX_RETRY_DELAY_MS,
          DURABLE_QUEUE_RESTORE_RETRY_DELAY_MS *
            2 ** Math.min(failures - 1, 16),
        );
        listener.durableQueueRestoreTimer = setTimeout(() => {
          listener.durableQueueRestoreTimer = undefined;
          scheduleDurableQueueRestore(listener, false);
        }, delay);
        listener.durableQueueRestoreTimer.unref?.();
      } finally {
        listener.durableQueueRestoreScheduled = false;
        const rerunRequested =
          listener.durableQueueRestoreRerunRequested === true;
        listener.durableQueueRestoreRerunRequested = false;
        if (rerunRequested && !listener.durableQueueRestoreTimer) {
          scheduleDurableQueueRestore(listener, false);
        }
      }
    })();
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
        scheduleDurableQueueRestore(listener);
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
        if (reason !== "shutdown") scheduleDurableQueueRestore(listener);
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
        scheduleDurableQueueRestore(listener);
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
  providedInterruptedRecords?: InterruptedTurnRecord[],
  options: { queuedOnly?: boolean } = {},
): number {
  promotePreparedInputTerminals(listener, terminalStore);
  let restored = 0;
  const interruptedRecords =
    providedInterruptedRecords ?? createInterruptedTurnStore().list();
  const interruptedIdentityKeys = new Set(
    interruptedRecords.flatMap((record) =>
      (record.durableInputIdentities ?? []).map((identity) =>
        JSON.stringify([
          record.agentId,
          record.conversationId,
          identity.domain,
          identity.id,
        ]),
      ),
    ),
  );
  // Dequeue marks an input started before the turn has written its first
  // interrupted record. Keep that narrow in-process handoff from looking like an
  // orphaned started payload during the capacity-release refill microtask.
  const volatileStartedIdentityKeys = new Set(
    [...listener.conversationRuntimes.values()].flatMap((runtime) =>
      [...runtime.dequeuedInputIdentitiesByBatchId.values()].flatMap(
        (identities) =>
          identities.map((identity) =>
            JSON.stringify([
              runtime.agentId,
              runtime.conversationId,
              identity.domain,
              identity.id,
            ]),
          ),
      ),
    ),
  );
  for (const { disposition, payload } of loadDurableQueuedInputEntries(
    listener,
  )) {
    if (options.queuedOnly && disposition !== "queued") continue;
    const identityKey = JSON.stringify([
      payload.scope.agentId,
      payload.scope.conversationId,
      payload.identity.domain,
      payload.identity.id,
    ]);
    if (
      disposition === "started" &&
      (interruptedIdentityKeys.has(identityKey) ||
        volatileStartedIdentityKeys.has(identityKey))
    ) {
      continue;
    }
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
    const replayOwner = [...listener.connections.values()].find(
      (connection) =>
        connection.initialized && connection.subscriptions.has(runtime.key),
    );
    const incoming = {
      ...payload.incoming,
      connectionId: replayOwner?.id,
      durableInputIdentities: [payload.identity],
    };
    if (
      !enqueueInboundUserMessage(runtime, incoming, payload.actingUserId, {
        preserveExisting: true,
      })
    ) {
      // The durable disposition remains authoritative and will be retried on a
      // later restart; rehydration never evicts or retires already accepted work.
      continue;
    }
    restored += 1;
  }
  return restored;
}

/** Promote terminal journals before connection state-sync attempts replay. */
export function promotePreparedInputTerminals(
  listener: ListenerRuntime,
  terminalStore = createTurnFinishedStore(),
  onlyScope?: { agentId: string | null; conversationId: string },
): number {
  let promoted = 0;
  for (const prepared of loadPreparedInputTerminals(listener)) {
    if (
      onlyScope &&
      (prepared.scope.agentId !== onlyScope.agentId ||
        prepared.scope.conversationId !== onlyScope.conversationId)
    ) {
      continue;
    }
    let owner = prepared.owner;
    let replayConnectionId: string | null = null;
    try {
      if (prepared.message.terminal_consumer_ids?.length) {
        const existing = terminalStore
          .read(prepared.scope.agentId, prepared.scope.conversationId)
          ?.terminals.find((terminal) =>
            prepared.owner.terminalIdentity
              ? terminal.owner.terminalIdentity ===
                prepared.owner.terminalIdentity
              : terminal.owner.terminalIdentity === undefined &&
                terminal.message.turn_id === prepared.message.turn_id,
          );
        if (existing) {
          // The terminal put may have committed just before the process crashed,
          // and ownership may since have rotated in the durable replay store.
          // Re-submit the prepared payload with that persisted owner so put still
          // performs its complete identity/message validation idempotently.
          owner = existing.owner;
          replayConnectionId = existing.owner.connectionId;
        } else if (owner.connectionId === null) {
          const runtime = getOrCreateScopedRuntime(
            listener,
            prepared.scope.agentId,
            prepared.scope.conversationId,
          );
          const activeConnection = runtime.activeConnectionId
            ? listener.connections.get(runtime.activeConnectionId)
            : undefined;
          const connection =
            runtime.activeConnectionId !== null
              ? activeConnection?.initialized &&
                activeConnection.subscriptions.has(runtime.key)
                ? activeConnection
                : undefined
              : [...listener.connections.values()].find(
                  (candidate) =>
                    candidate.initialized &&
                    candidate.subscriptions.has(runtime.key),
                );
          if (!connection) continue;
          owner = {
            ...owner,
            connectionId: connection.id,
            canRotate: connection.options.connectionIdCanResume === false,
            lineageId: connection.startupOwner.lineageId,
          };
          replayConnectionId = connection.id;
        } else {
          replayConnectionId = owner.connectionId;
        }
        // Always pass through the store's full identity-collision validation.
        // An existing identity is idempotent only when both payload and owner match.
        terminalStore.put(
          prepared.scope.agentId,
          prepared.scope.conversationId,
          prepared.message,
          owner,
        );
      }
    } catch (error) {
      if (error instanceof TurnFinishedCapacityError) continue;
      throw error;
    }
    if (
      !clearPreparedInputTerminal(
        listener,
        prepared.scope,
        prepared.message.turn_id,
        prepared.owner.terminalIdentity,
      )
    ) {
      throw new Error("Failed to promote prepared input terminal");
    }
    promoted += 1;
    if (replayConnectionId) {
      const connection = listener.connections.get(replayConnectionId);
      const streamWriter = connection?.streamWriter;
      const controlWriter = connection?.writer;
      const transport =
        streamWriter && isListenerTransportOpen(streamWriter)
          ? streamWriter
          : controlWriter && isListenerTransportOpen(controlWriter)
            ? controlWriter
            : undefined;
      if (connection?.initialized && transport) {
        replayPendingTurnFinishedToConnection(
          transport,
          getOrCreateScopedRuntime(
            listener,
            prepared.scope.agentId,
            prepared.scope.conversationId,
          ),
          connection.id,
          terminalStore,
        );
      }
    }
  }
  return promoted;
}
