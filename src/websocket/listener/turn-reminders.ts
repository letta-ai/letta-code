import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";

/** Prefer user input, falling back to a system trigger without inventing a user. */
export function getListenerReminderTarget(
  messages: ReadonlyArray<MessageCreate | ApprovalCreate>,
): MessageCreate | undefined {
  const userMessage = messages.find(
    (message): message is MessageCreate =>
      "role" in message && message.role === "user" && "content" in message,
  );
  return (
    userMessage ??
    messages.find(
      (message): message is MessageCreate =>
        "role" in message && message.role === "system" && "content" in message,
    )
  );
}
