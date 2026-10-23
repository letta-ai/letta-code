import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { SYSTEM_ALERT_OPEN, SYSTEM_REMINDER_OPEN } from "@/constants";
import { stripSystemReminders } from "./system-reminders";

export function getApprovalRecoveryInputText(
  input: Array<MessageCreate | ApprovalCreate>,
): string | null {
  const message = input.find((item) => item.type === "message");
  if (!message || !("content" in message)) return null;
  const content = message.content;
  const text =
    typeof content === "string"
      ? stripSystemReminders(content)
      : Array.isArray(content)
        ? content
            .filter(
              (part): part is { type: "text"; text: string } =>
                typeof part === "object" &&
                part !== null &&
                "type" in part &&
                part.type === "text" &&
                "text" in part &&
                typeof part.text === "string" &&
                !part.text.includes(SYSTEM_REMINDER_OPEN) &&
                !part.text.includes(SYSTEM_ALERT_OPEN),
            )
            .map((part) => part.text)
            .join("\n")
        : "";
  return text.trim() ? text : null;
}
