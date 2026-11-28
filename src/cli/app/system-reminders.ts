import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { SYSTEM_ALERT_CLOSE, SYSTEM_ALERT_OPEN } from "@/constants";
import {
  scheduledTaskPromptDisplayText,
  stripNonScheduledSystemReminders,
} from "@/cron/scheduled-task-prompt";

export function stripSystemReminders(text: string): string {
  const scheduled = scheduledTaskPromptDisplayText(text);
  if (scheduled !== null) return scheduled;
  return stripNonScheduledSystemReminders(text)
    .replace(
      new RegExp(`${SYSTEM_ALERT_OPEN}[\\s\\S]*?${SYSTEM_ALERT_CLOSE}`, "g"),
      "",
    )
    .trim();
}

export function getRestorableUserText(
  input: ReadonlyArray<MessageCreate | ApprovalCreate>,
): string {
  const message = input.find((item) => item?.type === "message");
  const content = message && "content" in message ? message.content : undefined;
  if (typeof content === "string") return stripSystemReminders(content);
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part.type === "text" ? [stripSystemReminders(part.text)] : [],
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}
