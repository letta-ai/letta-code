import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  DequeuedBatch,
  MessageQueueItem,
  TaskNotificationQueueItem,
} from "@/queue/queue-runtime";
import { mergeQueuedTurnInput } from "@/queue/turn-queue-runtime";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import { extractTaskNotificationsForDisplay } from "@/utils/task-notifications";
import { buildMessageContentFromDisplay } from "./paste-registry";

export function getQueuedNotificationSummaries(
  queued: QueuedMessage[],
): string[] {
  const summaries: string[] = [];
  for (const item of queued) {
    if (item.kind !== "task_notification") continue;
    const parsed = extractTaskNotificationsForDisplay(item.text);
    summaries.push(...parsed.notifications);
  }
  return summaries;
}

export function buildQueuedContentParts(
  queued: QueuedMessage[],
): MessageCreate["content"] {
  const queueInput = queued.map((item) =>
    item.kind === "task_notification"
      ? ({
          kind: "task_notification",
          text: item.text,
          content: item.content,
        } as const)
      : ({ kind: "user", content: item.text } as const),
  );

  const merged = mergeQueuedTurnInput(queueInput, {
    normalizeUserContent: buildMessageContentFromDisplay,
  });

  if (merged === null) {
    return [];
  }
  return merged;
}

export function buildQueuedUserText(queued: QueuedMessage[]): string {
  return queued
    .filter((item) => item.kind === "user")
    .map((item) => item.text)
    .filter((text) => text.length > 0)
    .join("\n");
}

export function toQueuedMsg(
  item: MessageQueueItem | TaskNotificationQueueItem,
): QueuedMessage {
  if (item.kind === "task_notification") {
    return {
      kind: "task_notification",
      text: item.text,
      content: item.content,
      queueItemId: item.id,
    };
  }
  const text =
    typeof item.content === "string"
      ? item.content
      : item.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("");
  return { kind: "user", text, queueItemId: item.id };
}

export function buildContentFromQueueBatch(
  batch: DequeuedBatch,
): MessageCreate["content"] {
  const queueInput = batch.items
    .filter(
      (item): item is MessageQueueItem | TaskNotificationQueueItem =>
        item.kind === "message" || item.kind === "task_notification",
    )
    .map((item) =>
      item.kind === "task_notification"
        ? ({
            kind: "task_notification",
            text: item.text,
            content: item.content,
          } as const)
        : ({
            kind: "user",
            content: item.content,
          } as const),
    );

  const merged = mergeQueuedTurnInput(queueInput, {
    normalizeUserContent: (content) =>
      typeof content === "string"
        ? buildMessageContentFromDisplay(content)
        : content,
  });

  if (merged === null) {
    return [];
  }
  return merged;
}
