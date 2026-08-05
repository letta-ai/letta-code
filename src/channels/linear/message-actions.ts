import type { ChannelMessageActionAdapter } from "@/channels/plugin-types";

export const linearMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool() {
    return { actions: ["send"] };
  },

  async handleAction({ adapter, request, formatText }) {
    if (request.action !== "send") {
      throw new Error(
        `Linear does not support MessageChannel action ${request.action}.`,
      );
    }
    const formatted = formatText(request.message ?? "");
    const result = await adapter.sendMessage({
      channel: "linear",
      chatId: request.chatId,
      text: formatted.text,
      parseMode: formatted.parseMode,
      replyToMessageId: request.replyToMessageId,
      threadId: request.threadId,
    });
    return `Message sent to Linear (message_id: ${result.messageId})`;
  },
};
