import type { ClientPreferences } from "@/types/client-preferences";
import type { QueuedMessage } from "@/utils/message-queue-bridge";

export function tuiSubmitClientPreferences(
  isSystemOnly: boolean,
  options?: { userInitiated: boolean },
): ClientPreferences | undefined {
  return !isSystemOnly && (options?.userInitiated ?? true) ? {} : undefined;
}

export function tuiQueuedClientPreferences(
  items: QueuedMessage[] | null,
): ClientPreferences | undefined {
  return items?.some((item) => item.kind === "user" && item.source !== "cron")
    ? {}
    : undefined;
}
