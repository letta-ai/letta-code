import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import {
  SYSTEM_ALERT_CLOSE,
  SYSTEM_ALERT_OPEN,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "@/constants";

export function stripSystemReminders(text: string): string {
  return text
    .replace(
      new RegExp(
        `${SYSTEM_REMINDER_OPEN}[\\s\\S]*?${SYSTEM_REMINDER_CLOSE}`,
        "g",
      ),
      "",
    )
    .replace(
      new RegExp(`${SYSTEM_ALERT_OPEN}[\\s\\S]*?${SYSTEM_ALERT_CLOSE}`, "g"),
      "",
    )
    .trim();
}

/** User-visible text of the first message in a turn input, minus reminders. */
export function getRestorableUserText(
  input: ReadonlyArray<MessageCreate | ApprovalCreate>,
): string {
  const message = input.find((item) => item?.type === "message");
  const content = message && "content" in message ? message.content : undefined;
  if (typeof content === "string") return stripSystemReminders(content);
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((c) =>
      c.type === "text" &&
      !c.text.includes(SYSTEM_REMINDER_OPEN) &&
      !c.text.includes(SYSTEM_ALERT_OPEN)
        ? [c.text]
        : [],
    )
    .join("\n")
    .trim();
}
