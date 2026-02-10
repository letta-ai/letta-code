import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
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
  const parts: MessageCreate["content"] = [];
  let isFirst = true;
  for (const item of queued) {
    if (!isFirst) {
      parts.push({ type: "text", text: "\n" });
    }
    isFirst = false;
    if (item.kind === "task_notification") {
      parts.push({ type: "text", text: item.text });
      continue;
    }
    const userParts = buildMessageContentFromDisplay(item.text);
    parts.push(...userParts);
  }
  return parts;
}

export function buildQueuedUserText(queued: QueuedMessage[]): string {
  return queued
    .filter((item) => item.kind === "user")
    .map((item) => item.text)
    .filter((text) => text.length > 0)
    .join("\n");
}
