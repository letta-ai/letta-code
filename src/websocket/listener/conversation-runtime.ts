import { type QueueItem, QueueRuntime } from "@/queue/queue-runtime";
import type { QueueRemovalTransition } from "@/types/queue-update-protocol";
import { debugWarn } from "@/utils/debug";
import { enqueueInboundUserMessage } from "./inbound-queue";
import {
  forgetQueuedInputDispositions,
  loadDurableQueuedInputEntries,
  markQueuedInputDispositionsStarted,
  ordinaryInputIdentity,
} from "./input-disposition";
import { PERMANENT_LEGACY_AUTHORITY_QUARANTINE_EXPIRY } from "./input-disposition-retention";
import {
  clearPreparedInputTerminal,
  discardPreparedInputTerminal,
  hasCompetingCompletedPublicationClaim,
  loadCompletedTerminalAuthorities,
  loadLegacyAuthorityQuarantines,
  loadPreparedInputTerminals,
  publishPreparedInputTerminalIfCurrent,
  quarantinePreparedTerminalAuthority,
} from "./input-terminal-journal";
import {
  createInterruptedTurnStore,
  type InterruptedTurnRecord,
} from "./interrupted-turn-record";
import { findRetiredSidecarQuarantine } from "./legacy-authority-quarantine";
import { getQueueItemScope, getQueueItemsScope } from "./queue";
import { scheduleQueueEmit } from "./queue-update-outbound";
import {
  evictConversationRuntimeIfIdle,
  getActiveRuntime,
  getConversationRuntimeKey,
  getOrCreateConversationRuntime,
} from "./runtime";
import { isListenerTransportOpen } from "./transport";
import {
  createTurnFinishedStore,
  type PersistedTurnFinished,
  replayPendingTurnFinishedToConnection,
  TurnFinishedCapacityError,
} from "./turn-finished-replay";
import type {
  ConversationRuntime,
  InterruptedTerminalAuthority,
  ListenerRuntime,
} from "./types";

const discardQueuedItem = (runtime: ConversationRuntime, item: QueueItem) => {
  runtime.queuedMessagesByItemId.delete(item.id);
};
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
const preparedTerminalPromotionRetries = new WeakMap<
  ListenerRuntime,
  { timer?: ReturnType<typeof setTimeout>; delayMs: number }
>();
const retiredAuthorityCleanupTimers = new WeakMap<
  ListenerRuntime,
  { timer: ReturnType<typeof setTimeout>; expiresAt: number }
>();
function scheduleRetiredAuthorityCleanup(
  listener: ListenerRuntime,
  expiresAt: number,
): void {
  const existing = retiredAuthorityCleanupTimers.get(listener);
  if (existing && existing.expiresAt <= expiresAt) return;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(
    () => {
      retiredAuthorityCleanupTimers.delete(listener);
      if (!listener.intentionallyClosed) {
        listener.promotePreparedInputTerminals?.();
      }
    },
    Math.max(0, expiresAt - Date.now() + 1),
  );
  timer.unref?.();
  retiredAuthorityCleanupTimers.set(listener, { timer, expiresAt });
}
function scheduleLegacyAuthorityQuarantineCleanup(
  listener: ListenerRuntime,
  expiresAt: number,
): void {
  if (expiresAt === PERMANENT_LEGACY_AUTHORITY_QUARANTINE_EXPIRY) return;
  scheduleRetiredAuthorityCleanup(listener, expiresAt);
}
function schedulePreparedTerminalPromotion(listener: ListenerRuntime): void {
  if (!listener.promotePreparedInputTerminals) return;
  const retry = preparedTerminalPromotionRetries.get(listener) ?? {
    delayMs: 25,
  };
  if (retry.timer) return;
  retry.timer = setTimeout(() => {
    retry.timer = undefined;
    if (!listener.intentionallyClosed) {
      listener.promotePreparedInputTerminals?.();
    }
  }, retry.delayMs);
  retry.timer.unref?.();
  retry.delayMs = Math.min(1_000, retry.delayMs * 2);
  preparedTerminalPromotionRetries.set(listener, retry);
}
function resetPreparedTerminalPromotionRetry(listener: ListenerRuntime): void {
  const retry = preparedTerminalPromotionRetries.get(listener);
  if (retry?.timer) clearTimeout(retry.timer);
  preparedTerminalPromotionRetries.delete(listener);
}
export function clearPreparedTerminalPromotionTimers(
  listener: ListenerRuntime,
): void {
  resetPreparedTerminalPromotionRetry(listener);
  const cleanup = retiredAuthorityCleanupTimers.get(listener);
  if (cleanup) clearTimeout(cleanup.timer);
  retiredAuthorityCleanupTimers.delete(listener);
}

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
        const restored = await Promise.resolve(
          listener.restoreDurableQueuedInputs?.() ?? 0,
        );
        if (restored > 0) {
          try {
            listener.scheduleRestoredQueuePumps?.();
          } catch (error) {
            debugWarn(
              "queue",
              "Failed to wake queue pumps after durable refill",
              error,
            );
          }
        }
        clearDurableQueueRestoreRetry(listener);
      } catch {
        const failures = (listener.durableQueueRestoreFailures ?? 0) + 1;
        listener.durableQueueRestoreFailures = failures;
        if (!durableQueueRestoreIsActive(listener)) {
          clearDurableQueueRestoreRetry(listener);
          return;
        }
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
        scheduleQueueEmit(listener, {
          agent_id: runtime.agentId,
          conversation_id: runtime.conversationId,
        });
      },
      onCleared: (reason, _clearedCount, items) => {
        runtime.pendingTurns = 0;
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
  options: {
    queuedOnly?: boolean;
    interruptedStore?: Pick<
      ReturnType<typeof createInterruptedTurnStore>,
      "listDurableInputOwnership"
    >;
  } = {},
): number {
  promotePreparedInputTerminals(listener, terminalStore);
  let restored = 0;
  const interruptedOwnership = providedInterruptedRecords
    ? providedInterruptedRecords.map((record) => ({
        agentId: record.agentId,
        conversationId: record.conversationId,
        durableInputIdentities: record.durableInputIdentities ?? [],
        quarantined: false,
      }))
    : (
        options.interruptedStore ?? createInterruptedTurnStore()
      ).listDurableInputOwnership();
  const interruptedIdentityKeys = new Set(
    interruptedOwnership.flatMap((record) =>
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
  const quarantinedInterruptedScopes = new Set(
    interruptedOwnership.flatMap((record) =>
      record.quarantined
        ? [JSON.stringify([record.agentId, record.conversationId])]
        : [],
    ),
  );
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
      (quarantinedInterruptedScopes.has(
        JSON.stringify([payload.scope.agentId, payload.scope.conversationId]),
      ) ||
        interruptedIdentityKeys.has(identityKey) ||
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
  interruptedStore: Pick<
    ReturnType<typeof createInterruptedTurnStore>,
    "readRecoverySnapshot" | "readRetiredRecoveryAuthority"
  > &
    Partial<
      Pick<
        ReturnType<typeof createInterruptedTurnStore>,
        | "compactRetiredRecoverySidecar"
        | "listRecoverySidecars"
        | "removeRetiredRecoverySidecar"
        | "withRecoveryAuthority"
      >
    > = createInterruptedTurnStore(),
  discardPreparedTerminal = discardPreparedInputTerminal,
  clearPreparedTerminal = clearPreparedInputTerminal,
  loadPreparedTerminals = loadPreparedInputTerminals,
): number {
  let promoted = 0;
  let deferred = false;
  let preparedTerminals: ReturnType<typeof loadPreparedInputTerminals>;
  let completedAuthorities: ReturnType<typeof loadCompletedTerminalAuthorities>;
  try {
    preparedTerminals = loadPreparedTerminals(listener);
    completedAuthorities = loadCompletedTerminalAuthorities(listener);
  } catch (error) {
    debugWarn(
      "recovery",
      "Failed to load prepared input terminals; deferring startup promotion",
      error,
    );
    schedulePreparedTerminalPromotion(listener);
    return 0;
  }
  for (const prepared of preparedTerminals) {
    if (
      onlyScope &&
      (prepared.scope.agentId !== onlyScope.agentId ||
        prepared.scope.conversationId !== onlyScope.conversationId)
    ) {
      deferred = true;
      continue;
    }
    let liveAuthorityGuard: typeof interruptedStore | undefined;
    if (
      !prepared.publicationClaimed &&
      prepared.owner.recoveryLineageId &&
      prepared.owner.interruptedRevision &&
      prepared.owner.interruptedAuthorityRevision
    ) {
      let snapshot: ReturnType<
        ReturnType<typeof createInterruptedTurnStore>["readRecoverySnapshot"]
      >;
      try {
        snapshot = interruptedStore.readRecoverySnapshot(
          prepared.scope.agentId ?? "",
          prepared.scope.conversationId,
          prepared.owner.recoveryLineageId,
        );
      } catch {
        deferred = true;
        continue;
      }
      let terminalRecord: ReturnType<typeof terminalStore.readOrThrow>;
      let persisted: PersistedTurnFinished | undefined;
      try {
        terminalRecord = terminalStore.readOrThrow(
          prepared.scope.agentId,
          prepared.scope.conversationId,
        );
        persisted = terminalRecord?.terminals.find((terminal) =>
          prepared.owner.terminalIdentity
            ? terminal.owner.terminalIdentity ===
              prepared.owner.terminalIdentity
            : terminal.message.turn_id === prepared.message.turn_id,
        );
      } catch {
        deferred = true;
        continue;
      }
      let staleAuthority = hasCompetingCompletedPublicationClaim(
        prepared,
        completedAuthorities,
      );
      if (!staleAuthority && !snapshot) {
        let retired: ReturnType<
          typeof interruptedStore.readRetiredRecoveryAuthority
        >;
        try {
          retired = interruptedStore.readRetiredRecoveryAuthority(
            prepared.scope.agentId ?? "",
            prepared.scope.conversationId,
            prepared.owner.recoveryLineageId,
          );
        } catch {
          deferred = true;
          continue;
        }
        if (!retired) {
          if (!persisted) {
            deferred = true;
            continue;
          }
        } else if (
          retired.interruptedRevision !== prepared.owner.interruptedRevision
        ) {
          staleAuthority = true;
        } else if (retired.authorityRevision) {
          staleAuthority =
            retired.authorityRevision !==
            prepared.owner.interruptedAuthorityRevision;
        } else {
          const evidence = new Map<string, number>();
          for (const candidate of preparedTerminals) {
            if (
              candidate.scope.agentId !== prepared.scope.agentId ||
              candidate.scope.conversationId !==
                prepared.scope.conversationId ||
              candidate.owner.recoveryLineageId !==
                prepared.owner.recoveryLineageId ||
              candidate.owner.interruptedRevision !==
                prepared.owner.interruptedRevision
            )
              continue;
            const identity =
              candidate.owner.terminalIdentity ?? candidate.message.turn_id;
            evidence.set(
              identity,
              Math.max(
                evidence.get(identity) ?? -1,
                candidate.preparationSequence ?? -1,
              ),
            );
          }
          for (const terminal of terminalRecord?.terminals ?? []) {
            if (
              terminal.owner.recoveryLineageId !==
                prepared.owner.recoveryLineageId ||
              terminal.owner.interruptedRevision !==
                prepared.owner.interruptedRevision
            )
              continue;
            const identity =
              terminal.owner.terminalIdentity ?? terminal.message.turn_id;
            evidence.set(
              identity,
              Math.max(
                evidence.get(identity) ?? -1,
                terminal.owner.preparationSequence ?? -1,
              ),
            );
          }
          const runtimeKey = getConversationRuntimeKey(
            prepared.scope.agentId,
            prepared.scope.conversationId,
          );
          let ambiguousCompletedAuthority:
            | InterruptedTerminalAuthority
            | undefined;
          for (const completed of completedAuthorities) {
            if (
              completed.runtimeKey !== runtimeKey ||
              completed.authority.recoveryLineageId !==
                prepared.owner.recoveryLineageId ||
              completed.authority.interruptedRevision !==
                prepared.owner.interruptedRevision
            )
              continue;
            let completedIdentity = completed.authority.terminalIdentity;
            let completedSequence = completed.authority.preparationSequence;
            if (!completedIdentity || completedSequence === undefined) {
              const inferred = new Map<string, number>();
              let conflictingInference = false;
              const recordInference = (identity: string, sequence: number) => {
                const previous = inferred.get(identity);
                if (previous !== undefined && previous !== sequence) {
                  conflictingInference = true;
                }
                inferred.set(identity, sequence);
              };
              for (const candidate of preparedTerminals) {
                if (
                  candidate.scope.agentId !== prepared.scope.agentId ||
                  candidate.scope.conversationId !==
                    prepared.scope.conversationId ||
                  candidate.owner.recoveryLineageId !==
                    prepared.owner.recoveryLineageId ||
                  candidate.owner.interruptedRevision !==
                    prepared.owner.interruptedRevision ||
                  candidate.owner.interruptedAuthorityRevision !==
                    completed.authority.authorityRevision
                )
                  continue;
                recordInference(
                  candidate.owner.terminalIdentity ?? candidate.message.turn_id,
                  candidate.preparationSequence ?? -1,
                );
              }
              for (const terminal of terminalRecord?.terminals ?? []) {
                if (
                  terminal.owner.recoveryLineageId !==
                    prepared.owner.recoveryLineageId ||
                  terminal.owner.interruptedRevision !==
                    prepared.owner.interruptedRevision ||
                  terminal.owner.interruptedAuthorityRevision !==
                    completed.authority.authorityRevision
                )
                  continue;
                recordInference(
                  terminal.owner.terminalIdentity ?? terminal.message.turn_id,
                  terminal.owner.preparationSequence ?? -1,
                );
              }
              const inferredEntry = [...inferred.entries()][0];
              if (
                conflictingInference ||
                inferred.size !== 1 ||
                !inferredEntry
              ) {
                ambiguousCompletedAuthority = completed.authority;
                break;
              }
              [completedIdentity, completedSequence] = inferredEntry;
            }
            if (
              !completedIdentity ||
              typeof completedSequence !== "number" ||
              !Number.isSafeInteger(completedSequence) ||
              completedSequence < 0
            ) {
              ambiguousCompletedAuthority = completed.authority;
              break;
            }
            evidence.set(
              completedIdentity,
              Math.max(
                evidence.get(completedIdentity) ?? -1,
                completedSequence,
              ),
            );
          }
          if (ambiguousCompletedAuthority) {
            try {
              if (
                !quarantinePreparedTerminalAuthority(
                  listener,
                  prepared.scope,
                  ambiguousCompletedAuthority,
                )
              ) {
                deferred = true;
              }
            } catch (error) {
              deferred = true;
              debugWarn(
                "recovery",
                "Failed to persist legacy terminal quarantine; deferring promotion",
                error,
              );
            }
            continue;
          }
          const newestSequence = Math.max(...evidence.values());
          const newest = [...evidence.entries()].filter(
            ([, sequence]) => sequence === newestSequence,
          );
          if (!Number.isSafeInteger(newestSequence) || newest.length !== 1) {
            deferred = true;
            continue;
          }
          const preparedIdentity =
            prepared.owner.terminalIdentity ?? prepared.message.turn_id;
          staleAuthority = newest[0]?.[0] !== preparedIdentity;
        }
      } else if (
        !staleAuthority &&
        snapshot !== null &&
        (snapshot.record.revision !== prepared.owner.interruptedRevision ||
          snapshot.revisionToken !==
            prepared.owner.interruptedAuthorityRevision)
      ) {
        if (snapshot.record.recoveryClaimCompletion?.state === "pending") {
          deferred = true;
          continue;
        }
        staleAuthority = true;
      }
      if (snapshot) liveAuthorityGuard = interruptedStore;
      if (staleAuthority) {
        try {
          if (persisted) {
            terminalStore.remove(
              prepared.scope.agentId,
              prepared.scope.conversationId,
              persisted.id,
            );
          }
          if (
            discardPreparedTerminal(
              listener,
              prepared.scope,
              prepared.owner.terminalIdentity,
              prepared.message.turn_id,
            )
          ) {
            continue;
          }
          debugWarn(
            "recovery",
            "Failed to discard stale prepared input terminal; deferring retry",
          );
          deferred = true;
        } catch (error) {
          deferred = true;
          debugWarn(
            "recovery",
            "Failed to remove stale persisted terminal; deferring cleanup",
            error,
          );
        }
        continue;
      }
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
        if (
          !publishPreparedInputTerminalIfCurrent(
            listener,
            prepared,
            () => {
              terminalStore.put(
                prepared.scope.agentId,
                prepared.scope.conversationId,
                prepared.message,
                {
                  ...owner,
                  preparationSequence: prepared.preparationSequence,
                },
              );
            },
            completedAuthorities,
            liveAuthorityGuard,
          )
        ) {
          continue;
        }
      }
    } catch (error) {
      deferred = true;
      debugWarn(
        "recovery",
        error instanceof TurnFinishedCapacityError
          ? "Prepared terminal capacity unavailable; deferring promotion"
          : "Failed to persist prepared terminal; deferring promotion",
        error,
      );
      continue;
    }
    if (
      !prepared.message.terminal_consumer_ids?.length &&
      !clearPreparedTerminal(
        listener,
        prepared.scope,
        prepared.message.turn_id,
        prepared.owner.terminalIdentity,
      )
    ) {
      deferred = true;
      debugWarn(
        "recovery",
        "Failed to clear promoted input terminal; deferring retry",
      );
      continue;
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
  let quarantines: ReturnType<typeof loadLegacyAuthorityQuarantines> = [];
  try {
    quarantines = loadLegacyAuthorityQuarantines(listener);
  } catch (error) {
    deferred = true;
    debugWarn("recovery", "Failed to load legacy authority quarantines", error);
  }
  if (
    interruptedStore.listRecoverySidecars &&
    interruptedStore.removeRetiredRecoverySidecar
  ) {
    try {
      const remainingJournals = loadPreparedTerminals(listener);
      for (const retired of interruptedStore
        .listRecoverySidecars()
        .filter((sidecar) => sidecar.state === "retired")) {
        const interruptedRevision =
          retired.retiredInterruptedRevision ?? retired.sourceMainRevision;
        const hasJournalReference = remainingJournals.some(
          (candidate) =>
            candidate.scope.agentId === retired.agentId &&
            candidate.scope.conversationId === retired.conversationId &&
            candidate.owner.recoveryLineageId === retired.lineageId &&
            candidate.owner.interruptedRevision === interruptedRevision,
        );
        if (hasJournalReference) continue;
        const quarantineReference = findRetiredSidecarQuarantine(
          quarantines,
          retired,
          interruptedRevision,
        );
        if (quarantineReference) {
          scheduleLegacyAuthorityQuarantineCleanup(
            listener,
            quarantineReference.expiresAt,
          );
          if (!interruptedStore.compactRetiredRecoverySidecar?.(retired)) {
            deferred = true;
          }
          continue;
        }
        const retiredRuntimeKey = getConversationRuntimeKey(
          retired.agentId,
          retired.conversationId,
        );
        const completedReference = completedAuthorities.find(
          (completed) =>
            completed.runtimeKey === retiredRuntimeKey &&
            completed.authority.recoveryLineageId === retired.lineageId &&
            completed.authority.interruptedRevision === interruptedRevision,
        );
        if (completedReference) {
          scheduleRetiredAuthorityCleanup(
            listener,
            completedReference.expiresAt,
          );
          continue;
        }
        const hasTerminalReference = Boolean(
          terminalStore
            .readOrThrow(retired.agentId, retired.conversationId)
            ?.terminals.some(
              (terminal) =>
                terminal.owner.recoveryLineageId === retired.lineageId &&
                terminal.owner.interruptedRevision === interruptedRevision,
            ),
        );
        if (hasTerminalReference) continue;
        if (
          !interruptedStore.removeRetiredRecoverySidecar(retired) &&
          !interruptedStore.compactRetiredRecoverySidecar?.(retired)
        ) {
          deferred = true;
        }
      }
    } catch (error) {
      deferred = true;
      debugWarn(
        "recovery",
        "Failed to sweep unreferenced retired recovery authority",
        error,
      );
    }
  }
  for (const quarantine of quarantines) {
    scheduleLegacyAuthorityQuarantineCleanup(listener, quarantine.expiresAt);
  }
  if (deferred) schedulePreparedTerminalPromotion(listener);
  else resetPreparedTerminalPromotionRetry(listener);
  return promoted;
}

export function promotePreparedInputTerminalsSafely(
  listener: ListenerRuntime,
): number {
  try {
    return promotePreparedInputTerminals(listener);
  } catch (error) {
    debugWarn(
      "recovery",
      "Prepared terminal promotion failed during listener startup",
      error,
    );
    schedulePreparedTerminalPromotion(listener);
    return 0;
  }
}
