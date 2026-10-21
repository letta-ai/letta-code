import type {
  DequeuedBatch,
  MessageQueueItem,
  TaskNotificationQueueItem,
} from "@/queue/queue-runtime";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import {
  buildContentFromQueueBatch,
  toQueuedMsg,
} from "./queued-message-parts";

/** Keep the scheduled origin when converting to the TUI's mid-turn queue shape. */
export function toTuiQueuedMessage(
  item: MessageQueueItem | TaskNotificationQueueItem,
): QueuedMessage {
  const message = toQueuedMsg(item);
  return item.source === "cron" ? { ...message, source: "cron" } : message;
}

/** Text for restoration, rich input, and origin must all describe the same batch. */
export function prepareTuiQueueSubmit(batch: DequeuedBatch) {
  return {
    text: batch.items
      .map((item) => {
        if (item.kind === "task_notification") return item.text;
        if (item.kind === "message" && typeof item.content === "string") {
          return item.content;
        }
        return "";
      })
      .filter((text) => text.length > 0)
      .join("\n"),
    content: buildContentFromQueueBatch(batch),
    submitOptions: {
      userInitiated: batch.items.some(
        (item) => item.kind === "message" && item.source === "user",
      ),
    },
  };
}
