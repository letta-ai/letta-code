import type { ChannelMessageActionAdapter } from "../pluginTypes";

export const telegramMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool() {
    return {
      actions: ["send"],
    };
  },

  async handleAction(ctx) {
    const { request, route, adapter, formatText } = ctx;

    if (request.action !== "send") {
      return `Error: Action "${request.action}" is not supported on telegram.`;
    }
    if (!request.message?.trim()) {
      return "Error: Telegram send requires message.";
    }

    const formatted = formatText(request.message);
    const result = await adapter.sendMessage({
      channel: "telegram",
      accountId: route.accountId,
      chatId: request.chatId,
      text: formatted.text,
      replyToMessageId: request.replyToMessageId,
      parseMode: formatted.parseMode,
    });

    return `Message sent to telegram (message_id: ${result.messageId})`;
  },
};
