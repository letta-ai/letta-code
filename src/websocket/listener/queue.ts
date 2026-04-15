import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type WebSocket from "ws";
import { getChannelRegistry } from "../../channels/registry";
import type {
  ChannelTurnOutcome,
  ChannelTurnSource,
} from "../../channels/types";
import { resizeImageIfNeeded } from "../../cli/helpers/imageResize";
import type {
  DequeuedBatch,
  QueueBlockedReason,
  QueueItem,
} from "../../queue/queueRuntime";
import { isCoalescable } from "../../queue/queueRuntime";
import { mergeQueuedTurnInput } from "../../queue/turnQueueRuntime";
import { trackBoundaryError } from "../../telemetry/errorReporting";
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
    }
  }

  return mergeQueuedTurnInput(queuedInputs, {
    normalizeUserContent: (content) => content,
  });
}

function getChannelTurnSourceKey(source: ChannelTurnSource): string {
  return [
    source.channel,
    source.accountId ?? "",
    source.chatId,
    source.messageId ?? "",
    source.threadId ?? "",
    source.agentId,
    source.conversationId,
  ].join(":");
}

function collectBatchChannelTurnSources(
  runtime: ConversationRuntime,
  batch: DequeuedBatch,
): ChannelTurnSource[] | undefined {
  const seen = new Set<string>();
  const sources: ChannelTurnSource[] = [];

  for (const item of batch.items) {
    const template = runtime.queuedMessagesByItemId.get(item.id);
    for (const source of template?.channelTurnSources ?? []) {
      const key = getChannelTurnSourceKey(source);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      sources.push(source);
    }
  }

  return sources.length > 0 ? sources : undefined;
}

async function dispatchChannelTurnLifecycleEvent(
  event:
    | {
        type: "processing";
        batchId: string;
        sources: ChannelTurnSource[];
      }
    | {
        type: "finished";
        batchId: string;
        sources: ChannelTurnSource[];
        outcome: ChannelTurnOutcome;
        error?: string;
      },
): Promise<void> {
  if (event.sources.length === 0) {
    return;
  }

  const registry = getChannelRegistry();
  if (!registry) {
    return;
  }

  if (event.type === "processing") {
    await registry.dispatchTurnLifecycleEvent(event);
    return;
  }

  await registry.dispatchTurnLifecycleEvent({
    type: "finished",
    batchId: event.batchId,
    sources: event.sources,
    outcome: event.outcome,
    ...(event.error ? { error: event.error } : {}),
  });
}

function mapTurnLifecycleOutcome(
  lastStopReason: string | null,
  didThrow: boolean,
): ChannelTurnOutcome {
  if (didThrow) {
    return "error";
  }
  if (lastStopReason === "cancelled") {
    return "cancelled";
  }
  if (lastStopReason && lastStopReason !== "end_turn") {
    return "error";
  }
  return "completed";
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
  const channelTurnSources = collectBatchChannelTurnSources(runtime, batch);
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
      ...(channelTurnSources ? { channelTurnSources } : {}),
      messages: [
        {
          role: "user",
          content: mergedContent,
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
    ...(channelTurnSources ? { channelTurnSources } : {}),
    messages,
  };
}

export function shouldQueueInboundMessage(parsed: IncomingMessage): boolean {
  return parsed.messages.some((payload) => "content" in payload);
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
    if (item.kind === "task_notification") {
      hasTaskNotification = true;
    }
    if (item.kind === "cron_prompt") {
      hasCronPrompt = true;
    }
  }

  if (
    (!hasMessage && !hasTaskNotification && !hasCronPrompt) ||
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
      const channelTurnSources = queuedTurn.channelTurnSources ?? [];

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
      if (channelTurnSources.length > 0) {
        await dispatchChannelTurnLifecycleEvent({
          type: "processing",
          batchId: dequeuedBatch.batchId,
          sources: channelTurnSources,
        });
      }

      let turnError: string | undefined;
      let didThrow = false;
      try {
        await processQueuedTurn(queuedTurn, dequeuedBatch);
      } catch (error) {
        didThrow = true;
        turnError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        if (channelTurnSources.length > 0) {
          await dispatchChannelTurnLifecycleEvent({
            type: "finished",
            batchId: dequeuedBatch.batchId,
            sources: channelTurnSources,
            outcome: mapTurnLifecycleOutcome(runtime.lastStopReason, didThrow),
            ...(turnError ? { error: turnError } : {}),
          });
        }
      }
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
