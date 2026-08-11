import type { ChannelTurnSource } from "@/channels/types";
import { isNonEmptyString } from "./utils";

const OUTBOUND_TYPING_SUPPRESSION_MS = 1_000;
export const DISCORD_TYPING_REFRESH_MS = 8_000;
// Lifecycle owns normal cleanup. This remains only as a lost-terminal backstop
// and slides on activity (typing pulses / outbound / new owners) so a healthy
// long turn is not measured from first start.
export const DISCORD_TYPING_MAX_MS = 6 * 60 * 60 * 1000;

type DiscordTypingEntry = {
  sourceKeys: Set<string>;
  timer: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
};

export function createDiscordTypingController(deps: {
  sendTypingAction: (channelId: string) => Promise<boolean>;
}) {
  const typingByChannelId = new Map<string, DiscordTypingEntry>();
  const lastTypingOutputAtByChannelId = new Map<string, number>();

  function getChannelId(source: ChannelTurnSource): string | null {
    if (source.channel !== "discord") return null;
    const channelId = source.threadId ?? source.chatId;
    return isNonEmptyString(channelId) ? channelId : null;
  }

  function getSourceKey(source: ChannelTurnSource): string | null {
    const channelId = getChannelId(source);
    if (!channelId) return null;
    return [
      source.accountId ?? "",
      channelId,
      source.messageId ?? "",
      source.agentId,
      source.conversationId,
    ].join(":");
  }

  function clearChannel(channelId: string): void {
    const entry = typingByChannelId.get(channelId);
    if (!entry) return;
    clearInterval(entry.timer);
    clearTimeout(entry.timeout);
    typingByChannelId.delete(channelId);
    lastTypingOutputAtByChannelId.delete(channelId);
  }

  function touchWatchdog(channelId: string): void {
    const entry = typingByChannelId.get(channelId);
    if (!entry) return;
    clearTimeout(entry.timeout);
    entry.timeout = setTimeout(() => {
      clearChannel(channelId);
    }, DISCORD_TYPING_MAX_MS);
    entry.timeout.unref?.();
  }

  async function start(source: ChannelTurnSource): Promise<void> {
    const channelId = getChannelId(source);
    const sourceKey = getSourceKey(source);
    if (!channelId || !sourceKey) return;

    const existing = typingByChannelId.get(channelId);
    if (existing) {
      existing.sourceKeys.add(sourceKey);
      touchWatchdog(channelId);
      return;
    }

    const timer = setInterval(() => {
      if (
        Date.now() - (lastTypingOutputAtByChannelId.get(channelId) ?? 0) <
        OUTBOUND_TYPING_SUPPRESSION_MS
      )
        return;
      void deps.sendTypingAction(channelId).then((ok) => {
        if (!ok) {
          clearChannel(channelId);
          return;
        }
        touchWatchdog(channelId);
      });
    }, DISCORD_TYPING_REFRESH_MS);
    timer.unref?.();
    const entry: DiscordTypingEntry = {
      sourceKeys: new Set([sourceKey]),
      timer,
      timeout: setTimeout(() => {
        clearChannel(channelId);
      }, DISCORD_TYPING_MAX_MS),
    };
    entry.timeout.unref?.();
    typingByChannelId.set(channelId, entry);
    if (!(await deps.sendTypingAction(channelId))) {
      const current = typingByChannelId.get(channelId);
      // Only tear down if this source is still the sole owner — siblings may
      // have been refcounted onto the entry while the initial typing await was
      // in flight.
      if (
        current === entry &&
        current.sourceKeys.size === 1 &&
        current.sourceKeys.has(sourceKey)
      ) {
        clearChannel(channelId);
      }
      return;
    }
    touchWatchdog(channelId);
  }

  function stop(source: ChannelTurnSource): void {
    const channelId = getChannelId(source);
    const sourceKey = getSourceKey(source);
    if (!channelId || !sourceKey) return;

    const entry = typingByChannelId.get(channelId);
    if (!entry) return;
    entry.sourceKeys.delete(sourceKey);
    if (entry.sourceKeys.size === 0) {
      clearChannel(channelId);
    }
  }

  function markOutbound(channelId: string): void {
    if (!typingByChannelId.has(channelId)) return;
    lastTypingOutputAtByChannelId.set(channelId, Date.now());
    touchWatchdog(channelId);
  }

  function clearAll(): void {
    for (const entry of typingByChannelId.values()) {
      clearInterval(entry.timer);
      clearTimeout(entry.timeout);
    }
    typingByChannelId.clear();
    lastTypingOutputAtByChannelId.clear();
  }

  return { clearAll, markOutbound, start, stop };
}
