import { LEGACY_CHANNEL_ACCOUNT_ID } from "./accounts";
import { getRoutesForChannel } from "./routing";
import type { ChannelAdapter, ChannelTurnSource } from "./types";

export function resolveChannelTurnSourcesForScope(
  adapters: Iterable<ChannelAdapter>,
  agentId: string,
  conversationId: string,
): ChannelTurnSource[] {
  const sources: ChannelTurnSource[] = [];
  const seen = new Set<string>();
  for (const adapter of adapters) {
    const channel = adapter.channelId ?? adapter.id;
    const accountId = adapter.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
    for (const route of getRoutesForChannel(channel, accountId)) {
      if (
        route.enabled === false ||
        route.agentId !== agentId ||
        route.conversationId !== conversationId
      ) {
        continue;
      }
      const key = `${channel}:${accountId}:${route.chatId}:${route.threadId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({
        channel,
        accountId,
        chatId: route.chatId,
        chatType: route.chatType,
        threadId: route.threadId ?? null,
        agentId,
        conversationId,
      });
    }
  }
  return sources;
}
