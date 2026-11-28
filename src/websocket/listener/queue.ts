import { retireMcpOriginatorTokenOnMixedMerge } from "@/agent/mcp-originator-tokens";
import {
  type AttributedMessageCreate,
  withMessageAttribution,
} from "@/agent/message-attribution";
import { getTask } from "@/cron/cron-file";
import { safeAppendCronRunLogForTask } from "@/cron/run-log";
import type {
  DequeuedBatch,
  QueueBlockedReason,
  QueueItem,
} from "@/queue/queue-runtime";
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
import { getInboundImageFailureMode, hasImageContent } from "./image-policy";
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

function getBatchActingUserId(items: QueueItem[]): string | null | undefined {
  const userMessages = items.filter((item) => item.kind === "message");
  if (userMessages.length > 0) return userMessages.at(-1)?.actingUserId;

  if (items.some((item) => item.actingUserId === null)) return null;
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
  imageFailureMode: IncomingMessage["imageFailureMode"],
): IncomingMessage | null {
  let template: IncomingMessage | undefined;
  const messages: IncomingMessage["messages"] = [];
  const durableInputIdentities: InputIdentity[] = [];
  const terminalConsumerIds = new Set<string>();
  const messageOriginatorIds: Array<string | undefined> = [];
  const originatorVotes: Array<string | null> = [];
  for (const item of batch.items) {
    const incoming = runtime.queuedMessagesByItemId.get(item.id);
    if (item.kind === "message" && incoming) {
      messageOriginatorIds.push(incoming.mcpOriginatorSuperRunId);
      originatorVotes.push(
        incoming.mcpOriginatorSuperRunId
          ? `${incoming.mcpOriginatorSuperRunId}${
              incoming.mcpOriginatorTokenPresent ? "|token" : "|tokenless"
            }`
          : null,
      );
      template ??= {
        ...incoming,
        actingUserId: incoming.actingUserId ?? item.actingUserId ?? undefined,
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
      messageOriginatorIds.push(undefined);
      originatorVotes.push(null);
      messages.push(
        withMessageAttribution(
          { role: "user", content: item.content },
          item.actingUserId ?? undefined,
        ),
      );
    } else {
      messageOriginatorIds.push(undefined);
      originatorVotes.push(null);
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
  const batchActingUserId = batch.items.some((item) => item.kind === "message")
    ? getBatchActingUserId(batch.items)
    : (template?.actingUserId ?? getBatchActingUserId(batch.items));
  const distinctOriginatorVotes = new Set(originatorVotes);
  const mcpOriginatorSuperRunId =
    distinctOriginatorVotes.size === 1
      ? ([...distinctOriginatorVotes][0]?.split("|")[0] ?? undefined)
      : undefined;
  if (distinctOriginatorVotes.size > 1) {
    for (const id of messageOriginatorIds) {
      retireMcpOriginatorTokenOnMixedMerge(id);
    }
  }
  const processOwnedTurn = !batch.items.some((item) => item.kind === "message");
  return {
    type: "message",
    agentId: scopeItem?.agentId ?? runtime.agentId ?? undefined,
    conversationId: scopeItem?.conversationId ?? runtime.conversationId,
    ...template,
    imageFailureMode,
    mcpOriginatorSuperRunId,
    ...(processOwnedTurn ? { processOwnedTurn: true } : {}),
    actingUserId: batchActingUserId ?? undefined,
    suppressActingUserFallback:
      batchActingUserId === null ||
      (batchActingUserId === undefined &&
        template?.suppressActingUserFallback === true),
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
    if (item.kind === "task_notification") {
      for (const clientMessageId of item.clientMessageIds ?? []) {
        clientMessageIds.add(clientMessageId);
      }
    }
  }
  return [...clientMessageIds];
}

export function shouldQueueInboundMessage(parsed: IncomingMessage): boolean {
  return parsed.messages.some((payload) => "content" in payload);
}

export function consumeQueuedTurn(
  runtime: ConversationRuntime,
  options?: { continuation?: boolean },
): {
  dequeuedBatch: DequeuedBatch;
  queuedTurn: IncomingMessage;
} | null {
  const queuedItems = runtime.queueRuntime.peekReady();
  const firstQueuedItem = queuedItems[0];
  if (!firstQueuedItem) {
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
  if (options?.continuation && isNoCoalesce(firstQueuedItem)) {
    return null;
  }
  for (const item of queuedItems) {
    if (!hasSameQueueScope(firstQueuedItem, item)) {
      break;
    }
    const incoming = runtime.queuedMessagesByItemId.get(item.id);
    if (incoming?.clientPreferences !== undefined) {
      const preferences = JSON.stringify(
        normalizeClientPreferences(incoming.clientPreferences),
      );
      if (
        preferences !== batchPreferences &&
        (queueLen > 0 || runtime.turnLifecycle.kind !== "idle")
      )
        break;
      batchPreferences = preferences;
    }
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
      const hasImages = incoming
        ? incoming.messages.some(
            (message) =>
              "content" in message && hasImageContent(message.content),
          )
        : hasImageContent(item.content);
      if (hasImages) {
        const itemImageFailureMode = getInboundImageFailureMode(incoming);
        if (
          batchImageFailureMode !== null &&
          itemImageFailureMode !== batchImageFailureMode
        ) {
          break;
        }
        batchImageFailureMode = itemImageFailureMode;
      }
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

  for (const item of dequeuedBatch.items) {
    if (item.kind !== "cron_prompt") continue;
    try {
      const task = getTask(item.cronTaskId);
      if (task && task.agent_id === item.agentId) {
        safeAppendCronRunLogForTask(task, {
          status: "ok",
          outcome: "delivered",
          reason: "dequeued",
          queueItemId: item.id,
          conversationId: item.conversationId,
          runAtMs: Date.now(),
        });
      }
    } catch (error) {
      debugWarn("Cron", "Error reading task for dequeued cron prompt:", error);
    }
  }

  const clientMessageIds = getDequeuedClientMessageIds(runtime, dequeuedBatch);
  const queuedTurn = buildQueuedTurnMessage(
    runtime,
    dequeuedBatch,
    batchImageFailureMode ?? undefined,
  );
  if (!queuedTurn) {
    return null;
  }
  if (clientMessageIds.length > 0) {
    runtime.dequeuedClientMessageIdsByBatchId.set(
      dequeuedBatch.batchId,
      clientMessageIds,
    );
  }
  if (queuedTurn.durableInputIdentities?.length) {
    runtime.dequeuedInputIdentitiesByBatchId.set(dequeuedBatch.batchId, [
      ...queuedTurn.durableInputIdentities,
    ]);
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
  const first = runtime.queueRuntime.peekReady()[0];
  if (
    first?.kind === "message" &&
    first.noCoalesce === true &&
    runtime.queuedMessagesByItemId.get(first.id)?.processOwnedTurn === true
  ) {
    return getOrCreateProcessTransport(runtime.listener);
  }
  if (
    runtime.listener.connections.size > 0 ||
    runtime.listener.processTransport !== null
  ) {
    const transport = getOrCreateProcessTransport(runtime.listener);
    if (!isListenerTransportOpen(transport)) return null;
    const localConnection = [...runtime.listener.connections.values()].some(
      (connection) =>
        connection.initialized &&
        "kind" in connection.writer &&
        connection.writer.kind === "local" &&
        isListenerTransportOpen(connection.writer),
    );
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

      const turnTransport = resolveQueuePumpTransport(runtime, socket);
      if (!turnTransport) return;

      const blockedReason = computeListenerQueueBlockedReason(runtime);
      if (blockedReason) {
        runtime.queueRuntime.tryDequeue(blockedReason);
        return;
      }

      if (runtime.queueRuntime.readyLength === 0) {
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
      emitQueuePumpBoundary(() =>
        emitQueueUpdate(turnTransport, runtime, {
          agent_id: runtime.agentId,
          conversation_id: runtime.conversationId,
        }),
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
          reportQueueStatusCallbackError(error);
        }
      }
      await processQueuedTurn(queuedTurn, dequeuedBatch);
      emitQueueListenerStatus(runtime, opts);
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
