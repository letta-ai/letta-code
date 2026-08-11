import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  DequeuedBatch,
  QueueBlockedReason,
  QueueItem,
} from "@/queue/queue-runtime";
import { isCoalescable } from "@/queue/queue-runtime";
import { mergeQueuedTurnInput } from "@/queue/turn-queue-runtime";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import { getListenerBlockedReason } from "@/websocket/helpers/listener-queue-adapter";
import { getInboundImageFailureMode } from "./image-policy";
import { emitDequeuedUserMessage } from "./protocol-outbound";
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

function mergeDequeuedBatchContent(
  items: QueueItem[],
): MessageCreate["content"] | null {
  const queuedInputs: Array<
    | { kind: "user"; content: MessageCreate["content"] }
    | {
        kind: "task_notification";
        text: string;
      }
    | {
        kind: "cron_prompt";
        text: string;
      }
  > = [];

  for (const item of items) {
    if (item.kind === "message") {
      queuedInputs.push({
        kind: "user",
        content: item.content,
      });
      continue;
    }
    if (item.kind === "task_notification") {
      queuedInputs.push({
        kind: "task_notification",
        text: item.text,
      });
      continue;
    }
    if (item.kind === "cron_prompt") {
      queuedInputs.push({
        kind: "cron_prompt",
        text: item.text,
      });
      continue;
    }
    if (item.kind === "mod_continue") {
      // A continue is plain user text — merge it as user content.
      queuedInputs.push({
        kind: "user",
        content: item.text,
      });
    }
  }

  return mergeQueuedTurnInput(queuedInputs, {
    normalizeUserContent: (content) => content,
  });
}

function getPrimaryQueueMessageItem(items: QueueItem[]): QueueItem | null {
  for (const item of items) {
    if (item.kind === "message") {
      return item;
    }
  }
  return null;
}

/**
 * Picks an acting cloud user id to attribute the outbound
 * createMessage to. When a batch coalesces messages from multiple
 * users we use the **last enqueued** sender — matches user intuition
 * ("whoever just hit send pays") and matches the seq order the queue
 * already preserves. Returns undefined when no item in the batch
 * carries an actingUserId (self-hosted / pre-channel-split flow).
 */
export function pickBatchActingUserId(items: QueueItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const actingUserId = items[i]?.actingUserId;
    if (actingUserId) {
      return actingUserId;
    }
  }
  return undefined;
}

function buildQueuedTurnMessage(
  runtime: ConversationRuntime,
  batch: DequeuedBatch,
): IncomingMessage | null {
  const actingUserId = pickBatchActingUserId(batch.items);
  const primaryItem = getPrimaryQueueMessageItem(batch.items);
  if (!primaryItem) {
    // No user message in the batch — this is a notification-only batch.
    // Build a synthetic IncomingMessage to restart the agent loop.
    for (const item of batch.items) {
      runtime.queuedMessagesByItemId.delete(item.id);
    }

    const mergedContent = mergeDequeuedBatchContent(batch.items);
    if (mergedContent === null) {
      return null;
    }

    // Determine scope from the batch items (they all share the same scope)
    const scopeItem = batch.items[0];
    return {
      type: "message",
      agentId: scopeItem?.agentId ?? runtime.agentId ?? undefined,
      conversationId: scopeItem?.conversationId ?? runtime.conversationId,
      ...(actingUserId ? { actingUserId } : {}),
      messages: [
        {
          role: "user",
          content: mergedContent,
          otid: crypto.randomUUID(),
        } satisfies MessageCreate,
      ],
    };
  }

  const template = runtime.queuedMessagesByItemId.get(primaryItem.id);
  for (const item of batch.items) {
    runtime.queuedMessagesByItemId.delete(item.id);
  }
  if (!template) {
    return null;
  }

  const mergedContent = mergeDequeuedBatchContent(batch.items);
  if (mergedContent === null) {
    return null;
  }

  const firstMessageIndex = template.messages.findIndex(
    (payload): payload is MessageCreate & { client_message_id?: string } =>
      "content" in payload,
  );
  if (firstMessageIndex === -1) {
    return null;
  }

  const firstMessage = template.messages[firstMessageIndex] as MessageCreate & {
    client_message_id?: string;
  };
  const mergedFirstMessage = {
    ...firstMessage,
    content: mergedContent,
  };
  const messages = template.messages.slice();
  messages[firstMessageIndex] = mergedFirstMessage;

  return {
    ...template,
    ...(actingUserId ? { actingUserId } : {}),
    messages,
  };
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
  const queuedItems = runtime.queueRuntime.peek();
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
  const isNoCoalesce = (candidate: (typeof queuedItems)[number]): boolean =>
    candidate.kind === "message" && candidate.noCoalesce === true;
  for (const item of queuedItems) {
    if (
      !isCoalescable(item.kind) ||
      !hasSameQueueScope(firstQueuedItem, item)
    ) {
      break;
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

  const queuedTurn = buildQueuedTurnMessage(runtime, dequeuedBatch);
  if (!queuedTurn) {
    return null;
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

      const blockedReason = computeListenerQueueBlockedReason(runtime);
      if (blockedReason) {
        runtime.queueRuntime.tryDequeue(blockedReason);
        return;
      }

      const consumedQueuedTurn = consumeQueuedTurn(runtime);
      if (!consumedQueuedTurn) {
        return;
      }

      const { dequeuedBatch, queuedTurn } = consumedQueuedTurn;
      emitDequeuedUserMessage(socket, runtime, queuedTurn, dequeuedBatch);

      const preTurnStatus =
        getListenerStatus(runtime.listener) === "processing"
          ? "processing"
          : "receiving";
      if (
        opts.connectionId &&
        runtime.listener.lastEmittedStatus !== preTurnStatus
      ) {
        runtime.listener.lastEmittedStatus = preTurnStatus;
        opts.onStatusChange?.(preTurnStatus, opts.connectionId);
      }
      await processQueuedTurn(queuedTurn, dequeuedBatch);
      emitListenerStatus(
        runtime.listener,
        opts.onStatusChange,
        opts.connectionId,
      );
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
        runtime.listener.intentionallyClosed ||
        !isListenerTransportOpen(socket)
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
      console.error("[Listen] Error in queue pump:", error);
      emitListenerStatus(
        runtime.listener,
        opts.onStatusChange,
        opts.connectionId,
      );
      evictConversationRuntimeIfIdle(runtime);
    });
}
