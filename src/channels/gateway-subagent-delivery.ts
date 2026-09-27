import {
  type ChannelSubagentNoticeOptions,
  type ChannelSubagentNoticeRoute,
  sameSubagentNoticeRoute,
} from "./gateway-subagent-notices";
import { formatOutboundChannelMessage } from "./message-channel-formatting";
import type { ChannelAdapter, ChannelTurnSource } from "./types";

/** Resolve authorization at send time, not from stale gateway registration. */
export function createChannelSubagentNoticeDelivery(
  registry: {
    resolveTurnSourcesForScope(
      agentId: string,
      conversationId: string,
    ): ChannelTurnSource[];
    getAdapter(channel: string, accountId: string): ChannelAdapter | null;
  },
  routes:
    | readonly ChannelSubagentNoticeRoute[]
    | (() => readonly ChannelSubagentNoticeRoute[]),
): ChannelSubagentNoticeOptions {
  return {
    get routes() {
      return typeof routes === "function" ? routes() : routes;
    },
    async send(source, text) {
      const optedIn = typeof routes === "function" ? routes() : routes;
      if (!optedIn.some((route) => sameSubagentNoticeRoute(route, source)))
        return;
      const authorized = registry
        .resolveTurnSourcesForScope(source.agentId, source.conversationId)
        .some((route) => sameSubagentNoticeRoute(route, source));
      if (!authorized) return;
      const adapter = registry.getAdapter(source.channel, source.accountId);
      if (!adapter?.isRunning()) return;
      await adapter.sendMessage({
        channel: source.channel,
        accountId: source.accountId,
        chatId: source.chatId,
        ...formatOutboundChannelMessage(source.channel, text),
        threadId: source.threadId ?? null,
      });
    },
  };
}
