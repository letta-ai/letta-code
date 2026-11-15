import type { QueuedMessage } from "@/utils/message-queue-bridge";

/** Preserve prepared notification parts across the bidirectional JSON line. */
export function serializeQueuedMessageAsUserLine(
  message: QueuedMessage,
): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: message.content ?? message.text },
    _queuedKind: message.kind,
  });
}
