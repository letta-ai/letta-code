import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
} from "@/channels/plugin-types";

async function sendFeishuMessage(
  ctx: ChannelMessageActionContext,
): Promise<string> {
  const { request, route, adapter, formatText } = ctx;
  const text = request.message ?? "";

  if (text.trim().length === 0) {
    return "Error: Feishu send requires message.";
  }

  const formatted = formatText(text);
  const result = await adapter.sendMessage({
    channel: "feishu",
    accountId: route.accountId,
    chatId: request.chatId,
    text: formatted.text,
    replyToMessageId: request.replyToMessageId,
    threadId: request.threadId ?? route.threadId ?? null,
  });

  return `Message sent to feishu (message_id: ${result.messageId})`;
}

export const feishuMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool() {
    return {
      actions: ["send"],
    };
  },

  async handleAction(ctx) {
    switch (ctx.request.action) {
      case "send":
        return await sendFeishuMessage(ctx);
      default:
        return `Error: Action "${ctx.request.action}" is not supported on feishu.`;
    }
  },
};
