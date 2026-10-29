import type { ClientPreferences } from "@/types/client-preferences";
import type { QueuedMessage } from "@/utils/message-queue-bridge";

/** Native submit and queue dispatch share one origin policy; constructing options is pure. */
export function tuiSubmitClientPreferences(
  isSystemOnly: boolean,
  options?: { userInitiated: boolean },
): ClientPreferences | undefined {
  return !isSystemOnly && (options?.userInitiated ?? true) ? {} : undefined;
}

/** Automatic continuations retain the prior UI choice; native user input clears it. */
export function tuiQueuedClientPreferences(
  items: QueuedMessage[] | null,
): ClientPreferences | undefined {
  return items?.some((item) => item.kind === "user" && item.source !== "cron")
    ? {}
    : undefined;
}
