import type { QueueControlCommand } from "@/types/queue-update-protocol";
import { isRuntimeScope } from "./protocol-validation";

/** Queue controls never add a message to the conversation. */
export function isQueueControlCommand(
  value: unknown,
): value is QueueControlCommand {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    type?: unknown;
    runtime?: unknown;
    request_id?: unknown;
    item_id?: unknown;
  };
  if (!isRuntimeScope(candidate.runtime)) return false;
  if (candidate.type === "steer_queue_item") {
    return (
      typeof candidate.request_id === "string" &&
      candidate.request_id.length > 0 &&
      typeof candidate.item_id === "string" &&
      candidate.item_id.length > 0
    );
  }
  return (
    candidate.type === "resume_queue" &&
    (candidate.request_id === undefined ||
      typeof candidate.request_id === "string")
  );
}
