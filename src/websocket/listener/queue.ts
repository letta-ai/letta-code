import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type WebSocket from "ws";
import { resizeImageIfNeeded } from "../../cli/helpers/imageResize";
import type {
  DequeuedBatch,
  QueueBlockedReason,
  QueueItem,
} from "../../queue/queueRuntime";
import { isCoalescable } from "../../queue/queueRuntime";
import { mergeQueuedTurnInput } from "../../queue/turnQueueRuntime";
import { getListenerBlockedReason } from "../helpers/listenerQueueAdapter";
import { emitDequeuedUserMessage } from "./protocol-outbound";
import {
  emitListenerStatus,
  evictConversationRuntimeIfIdle,
  getActiveRuntime,
  getListenerStatus,
  getPendingControlRequestCount,
} from "./runtime";
import { resolveRuntimeScope } from "./scope";
import type {
  ConversationRuntime,
  InboundMessagePayload,
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
    }
  }

  return mergeQueuedTurnInput(queuedInputs, {
    normalizeUserContent: (content) => content,
  });
}

function isBase64ImageContentPart(part: unknown): part is {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
} {
  if (!part || typeof part !== "object") {
    return false;
  }

  const candidate = part as {
    type?: unknown;
    source?: {
      type?: unknown;
      media_type?: unknown;
      data?: unknown;
    };
  };

  return (
    candidate.type === "image" &&
    !!candidate.source &&
    candidate.source.type === "base64" &&
    typeof candidate.source.media_type === "string" &&
    candidate.source.media_type.length > 0 &&
    typeof candidate.source.data === "string" &&
    candidate.source.data.length > 0
  );
}

export async function normalizeMessageContentImages(
  content: MessageCreate["content"],
  resize: typeof resizeImageIfNeeded = resizeImageIfNeeded,
): Promise<MessageCreate["content"]> {
  if (typeof content === "string") {
    return content;
  }

  let didChange = false;
  const normalizedParts = await Promise.all(
    content.map(async (part) => {
      if (!isBase64ImageContentPart(part)) {
        return part;
      }

      const resized = await resize(
        Buffer.from(part.source.data, "base64"),
        part.source.media_type,
      );
      if (
        resized.data !== part.source.data ||
        resized.mediaType !== part.source.media_type
      ) {
        didChange = true;
      }

      return {
        ...part,
        source: {
          ...part.source,
          type: "base64" as const,
          data: resized.data,
          media_type: resized.mediaType,
        },
      };
    }),
  );

  return didChange ? normalizedParts : content;
}

export async function normalizeInboundMessages(
  messages: InboundMessagePayload[],
  resize: typeof resizeImageIfNeeded = resizeImageIfNeeded,
): Promise<InboundMessagePayload[]> {
  let didChange = false;

  const normalizedMessages = await Promise.all(
    messages.map(async (message) => {
      if (!("content" in message)) {
        return message;
      }

      const normalizedContent = await normalizeMessageContentImages(
        message.content,
        resize,
      );
      if (normalizedContent !== message.content) {
        didChange = true;
        return {
          ...message,
          content: normalizedContent,
        };
      }
      return message;
    }),
  );

  return didChange ? normalizedMessages : messages;
}

function getPrimaryQueueMessageItem(items: QueueItem[]): QueueItem | null {
  for (const item of items) {
    if (item.kind === "message") {
      return item;
    }
  }
  return null;
}

function buildQueuedTurnMessage(
  runtime: ConversationRuntime,
  batch: DequeuedBatch,
): IncomingMessage | null {
  const primaryItem = getPrimaryQueueMessageItem(batch.items);
  if (!primaryItem) {
    for (const item of batch.items) {
      runtime.queuedMessagesByItemId.delete(item.id);
    }
    return null;
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
    messages,
  };
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
  for (const item of queuedItems) {
    if (
      !isCoalescable(item.kind) ||
      !hasSameQueueScope(firstQueuedItem, item)
    ) {
      break;
    }
    queueLen += 1;
    if (item.kind === "message") {
      hasMessage = true;
    }
  }

  if (!hasMessage) {
    return null;
  }
  if (queueLen === 0) {
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

export function shouldQueueInboundMessage(parsed: IncomingMessage): boolean {
  return parsed.messages.some((payload) => "content" in payload);
}

function computeListenerQueueBlockedReason(
  runtime: ConversationRuntime,
): QueueBlockedReason | null {
  const activeScope = resolveRuntimeScope(runtime.listener, {
    agent_id: runtime.agentId,
    conversation_id: runtime.conversationId,
  });
  return getListenerBlockedReason({
    loopStatus: runtime.loopStatus,
    isProcessing: runtime.isProcessing,
    pendingApprovalsLen: activeScope
      ? getPendingControlRequestCount(runtime.listener, activeScope)
      : 0,
    cancelRequested: runtime.cancelRequested,
    isRecoveringApprovals: runtime.isRecoveringApprovals,
  });
}

async function drainQueuedMessages(
  runtime: ConversationRuntime,
  socket: WebSocket,
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
  socket: WebSocket,
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
      console.error("[Listen] Error in queue pump:", error);
      emitListenerStatus(
        runtime.listener,
        opts.onStatusChange,
        opts.connectionId,
      );
      evictConversationRuntimeIfIdle(runtime);
    });
}
