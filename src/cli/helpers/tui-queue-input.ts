import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  DequeuedBatch,
  MessageQueueItem,
  QueueRuntime,
  TaskNotificationQueueItem,
} from "@/queue/queue-runtime";
import { debugLog } from "@/utils/debug";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import {
  buildContentFromQueueBatch,
  toQueuedMsg,
} from "./queued-message-parts";
import { takeTuiBusyInput } from "./tui-busy-input";

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

/** Recovered requests bypass submit hooks; ordinary batches retain their routing. */
export async function submitTuiQueuedInput(
  queue: QueueRuntime,
  handlers: {
    retry: (input: MessageCreate[]) => Promise<unknown>;
    submit: (
      input: ReturnType<typeof prepareTuiQueueSubmit>,
    ) => Promise<unknown>;
  },
): Promise<void> {
  const recovered = takeTuiBusyInput(queue);
  if (recovered) {
    await handlers.retry(recovered);
    return;
  }
  const batch = queue.consumeItems(queue.readyLength);
  if (!batch) return;
  const submission = prepareTuiQueueSubmit(batch);
  debugLog(
    "queue",
    `Dequeuing ${batch.mergedCount} message(s): "${submission.text.slice(0, 50)}"`,
  );
  await handlers.submit(submission);
}
