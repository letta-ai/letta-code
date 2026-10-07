import {
  type AttributedMessageCreate,
  withMessageAttribution,
} from "@/agent/message-attribution";
import type {
  DequeuedBatch,
  QueueBlockedReason,
  QueueItem,
} from "@/queue/queue-runtime";
import { isCoalescable } from "@/queue/queue-runtime";
import { buildTaskNotificationContent } from "@/queue/turn-queue-runtime";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import {
  getStoredClientPreferences,
  normalizeClientPreferences,
} from "@/tools/client-preferences";
import { debugWarn } from "@/utils/debug";
import { getListenerBlockedReason } from "@/websocket/helpers/listener-queue-adapter";
import {
  getOrCreateProcessTransport,
  getSubscribedListenerConnections,
} from "./connection";
import { getInboundImageFailureMode } from "./image-policy";
import { getInboundClientMessageIds } from "./inbound-queue";
import {
  emitDequeuedUserMessage,
  emitLoopStatusUpdate,
  emitQueueUpdate,
} from "./protocol-outbound";
import {
  emitListenerStatus,
  evictConversationRuntimeIfIdle,
  getActiveRuntime,
  getListenerStatus,
  getPendingControlRequestCount,
} from "./runtime";
import { resolveRuntimeScope } from "./scope";
import { isListenerTransportOpen, type ListenerTransport } from "./transport";
import type {
  ConversationRuntime,
  IncomingMessage,
  InputIdentity,
  StartListenerOptions,
} from "./types";

export function getQueueItemScope(item?: QueueItem | null): {
  agent_id?: string;
  conversation_id?: string;
} {
  if (!item) {
    return {};
  }
  return {
    agent_id: item.agentId,
    conversation_id: item.conversationId,
  };
}

export function getQueueItemsScope(items: QueueItem[]): {
  agent_id?: string;
  conversation_id?: string;
} {
  const first = items[0];
  if (!first) {
    return {};
  }
  const sameScope = items.every(
    (item) =>
      (item.agentId ?? null) === (first.agentId ?? null) &&
      (item.conversationId ?? null) === (first.conversationId ?? null),
  );
  return sameScope ? getQueueItemScope(first) : {};
}

function hasSameQueueScope(a: QueueItem, b: QueueItem): boolean {
  return (
    (a.agentId ?? null) === (b.agentId ?? null) &&
    (a.conversationId ?? null) === (b.conversationId ?? null)
  );
}

function getBatchActingUserId(items: QueueItem[]): string | undefined {
  // The latest ordinary user message owns a coalesced continuation request.
  // This deliberately returns undefined for an unattributed latest user so it
  // clears, rather than inherits, the actor from the turn being continued.
  const userMessages = items.filter((item) => item.kind === "message");
  if (userMessages.length > 0) return userMessages.at(-1)?.actingUserId;

  const actingUserId = items[0]?.actingUserId;
  if (
    !actingUserId ||
    items.some((item) => item.actingUserId !== actingUserId)
  ) {
    return undefined;
  }
  return actingUserId;
}

function buildQueuedTurnMessage(
  runtime: ConversationRuntime,
  batch: DequeuedBatch,
): IncomingMessage | null {
  let template: IncomingMessage | undefined;
  const messages: IncomingMessage["messages"] = [];
  const durableInputIdentities: InputIdentity[] = [];
  const terminalConsumerIds = new Set<string>();
  for (const item of batch.items) {
    const incoming = runtime.queuedMessagesByItemId.get(item.id);
    if (item.kind === "message" && incoming) {
      template ??= {
        ...incoming,
        actingUserId: incoming.actingUserId ?? item.actingUserId,
      };
      durableInputIdentities.push(...(incoming.durableInputIdentities ?? []));
      for (const consumerId of incoming.terminalConsumerIds ?? []) {
        terminalConsumerIds.add(consumerId);
      }
      messages.push(
        ...incoming.messages.map((message) =>
          "content" in message
            ? withMessageAttribution(
                message,
                item.actingUserId ?? incoming.actingUserId,
              )
            : message,
        ),
      );
    } else if (item.kind === "message") {
      messages.push(
        withMessageAttribution(
          { role: "user", content: item.content },
          item.actingUserId,
        ),
      );
    } else if (isCoalescable(item.kind) && "text" in item) {
      messages.push({
        role: "user",
        content:
          item.kind === "task_notification"
            ? buildTaskNotificationContent(item)
            : item.text,
        otid: crypto.randomUUID(),
        attribution: {},
      } satisfies AttributedMessageCreate);
    }
    runtime.queuedMessagesByItemId.delete(item.id);
  }
  if (messages.length === 0) return null;
  const scopeItem = batch.items[0];
  return {
    type: "message",
    agentId: scopeItem?.agentId ?? runtime.agentId ?? undefined,
    conversationId: scopeItem?.conversationId ?? runtime.conversationId,
    ...template,
    actingUserId: batch.items.some((item) => item.kind === "message")
      ? getBatchActingUserId(batch.items)
      : (template?.actingUserId ?? getBatchActingUserId(batch.items)),
    ...(durableInputIdentities.length > 0
      ? { durableInputIdentities: [...new Set(durableInputIdentities)] }
      : {}),
    ...(terminalConsumerIds.size > 0
      ? { terminalConsumerIds: [...terminalConsumerIds] }
      : {}),
    messages,
  };
}

function getDequeuedClientMessageIds(
  runtime: ConversationRuntime,
  batch: DequeuedBatch,
): string[] {
  const clientMessageIds = new Set<string>();
  for (const item of batch.items) {
    const queuedMessage = runtime.queuedMessagesByItemId.get(item.id);
    const inboundClientMessageIds = queuedMessage
      ? getInboundClientMessageIds(queuedMessage)
      : [];
    for (const clientMessageId of inboundClientMessageIds.length > 0
      ? inboundClientMessageIds
      : item.clientMessageId
        ? [item.clientMessageId]
        : []) {
      clientMessageIds.add(clientMessageId);
    }
  }
  return [...clientMessageIds];
}

export function shouldQueueInboundMessage(parsed: IncomingMessage): boolean {
  return parsed.messages.some((payload) => "content" in payload);
}

export function shouldProcessInboundMessageDirectly(
  runtime: ConversationRuntime,
  parsed: IncomingMessage,
): boolean {
  if (!shouldQueueInboundMessage(parsed)) {
    return false;
  }

  if (
    runtime.queueRuntime.length > 0 ||
    runtime.queuePumpActive ||
    runtime.queuePumpScheduled ||
    runtime.pendingTurns > 0 ||
    runtime.queuedMessagesByItemId.size > 0 ||
    runtime.turnLifecycle.kind !== "idle" ||
    runtime.pendingApprovalResolvers.size > 0 ||
    runtime.pendingApprovalBatchByToolCallId.size > 0 ||
    runtime.recoveredApprovalState !== null ||
    runtime.pendingInterruptedResults !== null ||
    runtime.pendingInterruptedContext !== null ||
    (runtime.pendingInterruptedToolCallIds?.length ?? 0) > 0
  ) {
    return false;
  }

  const activeScope = resolveRuntimeScope(runtime.listener, {
    agent_id: runtime.agentId,
    conversation_id: runtime.conversationId,
  });
  return (
    getListenerBlockedReason(
      runtime.turnLifecycle.snapshot(),
      activeScope
        ? getPendingControlRequestCount(runtime.listener, activeScope)
        : 0,
    ) === null
  );
}

export function consumeQueuedTurn(runtime: ConversationRuntime): {
  dequeuedBatch: DequeuedBatch;
  queuedTurn: IncomingMessage;
} | null {
  const queuedItems = runtime.queueRuntime.peekReady();
  const firstQueuedItem = queuedItems[0];
  if (!firstQueuedItem || !isCoalescable(firstQueuedItem.kind)) {
    return null;
  }

  let queueLen = 0;
  let hasMessage = false;
  let hasTaskNotification = false;
  let hasCronPrompt = false;
  let hasModContinue = false;
  let batchConnectionId: string | undefined;
  let batchImageFailureMode: "strict" | "drop" | null = null;
  let batchPreferences = JSON.stringify(
    getStoredClientPreferences(runtime.agentId, runtime.conversationId),
  );
  const isNoCoalesce = (candidate: (typeof queuedItems)[number]): boolean =>
    candidate.kind === "message" && candidate.noCoalesce === true;
  for (const item of queuedItems) {
    if (
      !isCoalescable(item.kind) ||
      !hasSameQueueScope(firstQueuedItem, item)
    ) {
      break;
    }
    const incoming = runtime.queuedMessagesByItemId.get(item.id);
    if (incoming?.clientPreferences !== undefined) {
      const preferences = JSON.stringify(
        normalizeClientPreferences(incoming.clientPreferences),
      );
      // A changed selection starts a new turn; identical UI snapshots can steer it.
      if (
        preferences !== batchPreferences &&
        (queueLen > 0 || runtime.turnLifecycle.kind !== "idle")
      )
        break;
      batchPreferences = preferences;
    }
    // noCoalesce items run as single-item batches: one never joins an
    // existing batch, and nothing joins a batch it started.
    if (queueLen > 0 && (isNoCoalesce(item) || isNoCoalesce(firstQueuedItem))) {
      break;
    }

    if (item.kind === "message") {
      const itemConnectionId = runtime.queuedMessagesByItemId.get(
        item.id,
      )?.connectionId;
      if (
        batchConnectionId !== undefined &&
        itemConnectionId !== undefined &&
        itemConnectionId !== batchConnectionId
      ) {
        break;
      }
      batchConnectionId ??= itemConnectionId;
      const itemImageFailureMode = getInboundImageFailureMode(
        runtime.queuedMessagesByItemId.get(item.id),
      );
      if (
        batchImageFailureMode !== null &&
        itemImageFailureMode !== batchImageFailureMode
      ) {
        break;
      }
      batchImageFailureMode = itemImageFailureMode;
    }

    queueLen += 1;
    if (item.kind === "message") {
      hasMessage = true;
    }
    if (item.kind === "task_notification") {
      hasTaskNotification = true;
    }
    if (item.kind === "cron_prompt") {
      hasCronPrompt = true;
    }
    if (item.kind === "mod_continue") {
      hasModContinue = true;
    }
  }

  if (
    (!hasMessage &&
      !hasTaskNotification &&
      !hasCronPrompt &&
      !hasModContinue) ||
    queueLen === 0
  ) {
    return null;
  }

  const dequeuedBatch = runtime.queueRuntime.consumeItems(queueLen);
  if (!dequeuedBatch) {
    return null;
  }

  const clientMessageIds = getDequeuedClientMessageIds(runtime, dequeuedBatch);
  const queuedTurn = buildQueuedTurnMessage(runtime, dequeuedBatch);
  if (!queuedTurn) {
    return null;
  }
  if (clientMessageIds.length > 0) {
    runtime.dequeuedClientMessageIdsByBatchId.set(
      dequeuedBatch.batchId,
      clientMessageIds,
    );
  }

  return {
    dequeuedBatch,
    queuedTurn,
  };
}

function computeListenerQueueBlockedReason(
  runtime: ConversationRuntime,
): QueueBlockedReason | null {
  const activeScope = resolveRuntimeScope(runtime.listener, {
    agent_id: runtime.agentId,
    conversation_id: runtime.conversationId,
  });
  return getListenerBlockedReason(
    runtime.turnLifecycle.snapshot(),
    activeScope
      ? getPendingControlRequestCount(runtime.listener, activeScope)
      : 0,
  );
}

/**
 * Turn-boundary status re-emit (LET-11174). Queue frames are emitted only on
 * change and loop frames only on transition, so one lost frame leaves
 * downstream status consumers stale until the next change happens to land.
 * Re-sending the full snapshot at turn start and turn end bounds any silent
 * frame loss to a single turn. Both frames coalesce as status-class snapshots
 * on the outbound wire, so unchanged re-emits cost at most one extra frame
 * each per boundary.
 */
function emitTurnBoundaryStatus(
  runtime: ConversationRuntime,
  socket: ListenerTransport,
): void {
  if (!isListenerTransportOpen(socket)) {
    return;
  }
  const scope = {
    agent_id: runtime.agentId,
    conversation_id: runtime.conversationId,
  };
  emitQueueUpdate(socket, runtime, scope);
  emitLoopStatusUpdate(socket, runtime, scope);
}

function reportQueueStatusCallbackError(error: unknown): void {
  trackBoundaryError({
    errorType: "listener_status_callback_failed",
    error,
    context: "listener_queue_pump",
  });
  debugWarn("Listen", "Error in listener status callback:", error);
}

function emitQueueListenerStatus(
  runtime: ConversationRuntime,
  opts: StartListenerOptions,
): void {
  try {
    emitListenerStatus(
      runtime.listener,
      opts.onStatusChange,
      opts.connectionId,
    );
  } catch (error) {
    reportQueueStatusCallbackError(error);
  }
}

function emitQueuePumpBoundary(operation: () => void): void {
  try {
    operation();
  } catch (error) {
    // Queue ownership has already transferred. Outbound projection failures must
    // not strand committed work, and restoring after a partial send could replay
    // user-visible side effects.
    trackBoundaryError({
      errorType: "listener_queue_boundary_failed",
      error,
      context: "listener_queue_pump",
    });
    debugWarn("Listen", "Error emitting listener queue boundary:", error);
  }
}

function resolveQueuePumpTransport(
  runtime: ConversationRuntime,
  socket: ListenerTransport,
): ListenerTransport | null {
  // A scheduled pump may outlive the socket that accepted its input. Route
  // through the process transport once connections are tracked so a reconnect
  // can replace the writer without replacing the queue's single pump.
  if (
    runtime.listener.connections.size > 0 ||
    runtime.listener.processTransport !== null
  ) {
    const transport = getOrCreateProcessTransport(runtime.listener);
    if (!isListenerTransportOpen(transport)) return null;
    // ProcessRuntimeTransport.isOpen() only means *some* connection is open.
    // Queued input for this scope must have a live recipient before dequeue;
    // otherwise its user echo and status are silently dropped. Local channel
    // listeners intentionally execute without a remote subscriber.
    const localConnection = [...runtime.listener.connections.values()].some(
      (connection) =>
        connection.initialized &&
        "kind" in connection.writer &&
        connection.writer.kind === "local" &&
        isListenerTransportOpen(connection.writer),
    );
    // Only client-sent input waits for a subscriber. Process-originated work
    // (cron, task notifications) has no client waiting to receive its echo.
    const hasClientInput = runtime.queueRuntime
      .peekReady()
      .some((item) => item.source === "user");
    if (
      !localConnection &&
      hasClientInput &&
      getSubscribedListenerConnections(runtime.listener, {
        agent_id: runtime.agentId,
        conversation_id: runtime.conversationId,
      }).length === 0
    ) {
      return null;
    }
    return transport;
  }
  // Untracked test/legacy transports have no process connection to follow.
  return isListenerTransportOpen(socket) ? socket : null;
}

async function drainQueuedMessages(
  runtime: ConversationRuntime,
  socket: ListenerTransport,
  opts: StartListenerOptions,
  processQueuedTurn: (
    queuedTurn: IncomingMessage,
    dequeuedBatch: DequeuedBatch,
  ) => Promise<void>,
): Promise<void> {
  if (runtime.queuePumpActive) {
    return;
  }

  runtime.queuePumpActive = true;
  try {
    while (true) {
      if (
        runtime.listener !== getActiveRuntime() ||
        runtime.listener.intentionallyClosed
      ) {
        return;
      }

      // Do not consume a batch without a live delivery path. On reconnect,
      // the next iteration picks up the replacement writer automatically.
      const turnTransport = resolveQueuePumpTransport(runtime, socket);
      if (!turnTransport) return;

      const blockedReason = computeListenerQueueBlockedReason(runtime);
      if (blockedReason) {
        runtime.queueRuntime.tryDequeue(blockedReason);
        return;
      }

      if (runtime.queueRuntime.readyLength === 0) {
        // Only interrupt-parked user messages remain: report it once and wait
        // for resume_queue or the next inbound message.
        if (runtime.queueRuntime.length > 0) {
          runtime.queueRuntime.tryDequeue("paused_by_user");
        }
        return;
      }

      const consumedQueuedTurn = consumeQueuedTurn(runtime);
      if (!consumedQueuedTurn) {
        return;
      }

      const { dequeuedBatch, queuedTurn } = consumedQueuedTurn;
      emitQueuePumpBoundary(() =>
        emitDequeuedUserMessage(
          turnTransport,
          runtime,
          queuedTurn,
          dequeuedBatch,
        ),
      );
      // Turn start boundary: unconditional snapshot even when nothing changed.
      emitQueuePumpBoundary(() =>
        emitTurnBoundaryStatus(runtime, turnTransport),
      );

      const preTurnStatus =
        getListenerStatus(runtime.listener) === "processing"
          ? "processing"
          : "receiving";
      if (
        opts.connectionId &&
        runtime.listener.lastEmittedStatus !== preTurnStatus
      ) {
        runtime.listener.lastEmittedStatus = preTurnStatus;
        try {
          opts.onStatusChange?.(preTurnStatus, opts.connectionId);
        } catch (error) {
          // The item is already dequeued and its stable ID is committed. A host
          // callback must not strand accepted work that a retry will deduplicate.
          reportQueueStatusCallbackError(error);
        }
      }
      await processQueuedTurn(queuedTurn, dequeuedBatch);
      emitQueueListenerStatus(runtime, opts);
      // Turn end boundary: repair any queue/loop frame the turn's own
      // change-driven emissions failed to deliver.
      const endTransport = resolveQueuePumpTransport(runtime, socket);
      if (endTransport) {
        emitQueuePumpBoundary(() =>
          emitTurnBoundaryStatus(runtime, endTransport),
        );
      }
      evictConversationRuntimeIfIdle(runtime);
    }
  } finally {
    runtime.queuePumpActive = false;
    evictConversationRuntimeIfIdle(runtime);
  }
}

export function scheduleQueuePump(
  runtime: ConversationRuntime,
  socket: ListenerTransport,
  opts: StartListenerOptions,
  processQueuedTurn: (
    queuedTurn: IncomingMessage,
    dequeuedBatch: DequeuedBatch,
  ) => Promise<void>,
): void {
  if (runtime.queuePumpScheduled) {
    return;
  }
  runtime.queuePumpScheduled = true;
  runtime.messageQueue = runtime.messageQueue
    .then(async () => {
      runtime.queuePumpScheduled = false;
      if (
        runtime.listener !== getActiveRuntime() ||
        runtime.listener.intentionallyClosed
      ) {
        return;
      }
      await drainQueuedMessages(runtime, socket, opts, processQueuedTurn);
    })
    .catch((error: unknown) => {
      runtime.queuePumpScheduled = false;
      trackBoundaryError({
        errorType: "listener_queue_pump_failed",
        error,
        context: "listener_queue_pump",
      });
      debugWarn("Listen", "Error in queue pump:", error);
      emitQueueListenerStatus(runtime, opts);
      evictConversationRuntimeIfIdle(runtime);
    });
}
