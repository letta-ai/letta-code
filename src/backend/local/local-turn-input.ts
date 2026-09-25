import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { isRecord } from "@/utils/type-guards";

function wrapInSystemReminder(text: string): string {
  return `${SYSTEM_REMINDER_OPEN}\n${text}\n${SYSTEM_REMINDER_CLOSE}`;
}

function systemReminderContent(content: unknown): unknown {
  if (typeof content === "string") {
    return wrapInSystemReminder(content);
  }
  if (Array.isArray(content)) {
    return content.map((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? { ...part, text: wrapInSystemReminder(part.text) }
        : part,
    );
  }
  return content;
}

/**
 * Normalizes one turn-input message for Local backend ingestion.
 *
 * The Local message model (pi-ai) has no mid-conversation system role, and
 * providers such as Anthropic reject system-role messages after an assistant
 * message. Returning `role: "system"` messages from a `turn_start` mod (as
 * the typed `MessageCreate` input allows) would otherwise be silently
 * dropped, so they are normalized to the harness-standard model-visible form:
 * a user message whose content is wrapped in `<system-reminder>` tags. The
 * transcript echo strips reminder-only content from user bubbles, keeping the
 * injected context out of the visible conversation.
 *
 * Returns the message to append, or null when the role is not persistable
 * (approvals are applied separately by the caller).
 */
export function turnInputMessageForLocalAppend(
  message: Record<string, unknown>,
): Record<string, unknown> | null {
  if (message.role === "user") return message;
  if (message.role !== "system") return null;
  return {
    ...message,
    role: "user",
    content: systemReminderContent(message.content),
  };
}
