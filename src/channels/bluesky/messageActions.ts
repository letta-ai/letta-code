import type { ChannelMessageActionAdapter } from "../pluginTypes";

/**
 * Bluesky V1 surface for the shared MessageChannel tool.
 *
 * Only `send` is wired — produces a plain-text reply in the current thread
 * via `adapter.sendMessage`. Likes/reposts/quotes/follows/blocks live in
 * social-cli for now. A follow-up PR will add `like`, `repost`, `quote`,
 * `follow`, `block` actions here once the lexicon coverage stabilizes.
 */
export const blueskyMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool() {
    return {
      actions: ["send"],
    };
  },

  async handleAction(ctx) {
    const { request, route, adapter } = ctx;

    if (request.action !== "send") {
      return `Error: Action "${request.action}" is not supported on bluesky in v1. Use social-cli for likes, reposts, quotes, follows, or threaded posts.`;
    }

    const text = request.message?.trim();
    if (!text) {
      return "Error: Bluesky send requires message.";
    }

    try {
      const result = await adapter.sendMessage({
        channel: "bluesky",
        accountId: route.accountId,
        chatId: request.chatId,
        text,
        replyToMessageId: request.replyToMessageId,
      });
      return `Reply posted to bluesky (uri: ${result.messageId})`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      return `Error: Bluesky send failed: ${msg}`;
    }
  },
};
