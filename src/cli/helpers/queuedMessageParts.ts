import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  DequeuedBatch,
  MessageQueueItem,
  TaskNotificationQueueItem,
} from "../../queue/queueRuntime";
import { mergeQueuedTurnInput } from "../../queue/turnQueueRuntime";
import type { QueuedMessage } from "./messageQueueBridge";
import { buildMessageContentFromDisplay } from "./pasteRegistry";
import { extractTaskNotificationsForDisplay } from "./taskNotifications";

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
      ? ({ kind: "task_notification", text: item.text } as const)
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

/**
 * Convert a QueueItem (message or task_notification) to the QueuedMessage
 * shape used by the TUI display state and callers of consumeQueuedMessages.
 *
 * In the TUI, MessageQueueItem.content is always a plain string (the display
 * text from the input field). The fallback array-flatten path handles any
 * future case where content arrives as content parts.
 */
export function toQueuedMsg(
  item: MessageQueueItem | TaskNotificationQueueItem,
): QueuedMessage {
  if (item.kind === "task_notification") {
    return { kind: "task_notification", text: item.text };
  }
  const text =
    typeof item.content === "string"
      ? item.content
      : item.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("");
  return { kind: "user", text };
}

/**
 * Build merged MessageCreate content from a DequeuedBatch.
 *
 * Produces identical output to buildQueuedContentParts() for equivalent
 * inputs — this is enforced by the golden parity test. The difference is
 * that the input is QueueItem[] (from QueueRuntime) instead of QueuedMessage[].
 *
 * Only message and task_notification items contribute to the content batch;
 * barrier items (approval_result, overlay_action) are skipped.
 */
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
        ? ({ kind: "task_notification", text: item.text } as const)
        : ({
            kind: "user",
            content: item.content,
          } as const),
    );

  const merged = mergeQueuedTurnInput(queueInput, {
    // For string content (common TUI case), apply paste-registry resolution
    // exactly as buildQueuedContentParts does. For already-normalized content
    // parts, pass through unchanged.
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
