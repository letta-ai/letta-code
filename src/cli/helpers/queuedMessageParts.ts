import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
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
