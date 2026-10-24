import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { QueueRuntime } from "@/queue/queue-runtime";

const retryInputs = new WeakMap<object, MessageCreate>();

/** Call only for a pre-stream request known not to have been accepted.
 * Accepted requests must pass [] so only the remaining queue is parked.
 * Approval/tool-result payloads are never replayed by this recovery path.
 */
export function parkTuiBusyInput(
  queue: QueueRuntime,
  input: Array<MessageCreate | ApprovalCreate>,
): void {
  for (const message of [...input].reverse()) {
    if (!("role" in message) || message.role !== "user") continue;
    const item = queue.prependMessage(
      message.content,
      message.otid ?? undefined,
    );
    retryInputs.set(item, message);
  }
  queue.pause(true);
}

/** Consume only the retry prefix, after explicit resume. Never merge it with
 * later user input or regenerate its request OTIDs / rich content.
 */
export function takeTuiBusyInput(queue: QueueRuntime): MessageCreate[] | null {
  const messages: MessageCreate[] = [];
  for (const item of queue.peekReady()) {
    const message = retryInputs.get(item);
    if (!message) break;
    messages.push(message);
  }
  if (!messages.length || !queue.consumeItems(messages.length)) return null;
  return messages;
}

/** A resumed rejected request bypasses the ordinary defer-until-end-turn gate. */
export function hasTuiBusyInput(queue: QueueRuntime | null): boolean {
  const first = queue?.peekReady()[0];
  return first !== undefined && retryInputs.has(first);
}
