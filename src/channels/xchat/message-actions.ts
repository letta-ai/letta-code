import type { ChannelMessageActionAdapter } from "@/channels/plugin-types";

export const xchatMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool() {
    return { actions: ["send", "react", "upload-file"] };
  },

  async handleAction(ctx) {
    const { request, route, adapter, formatText } = ctx;
    if (request.action === "react") {
      if (!request.messageId?.trim()) {
        return "Error: X Chat react requires messageId.";
      }
      if (!request.emoji?.trim()) {
        return "Error: X Chat react requires emoji.";
      }
      const result = await adapter.sendMessage({
        channel: "xchat",
        accountId: route.accountId,
        chatId: request.chatId,
        text: "",
        targetMessageId: request.messageId,
        reaction: request.emoji,
        removeReaction: request.remove,
      });
      return request.remove
        ? `Reaction removed on X Chat (message_id: ${result.messageId})`
        : `Reaction added on X Chat (message_id: ${result.messageId})`;
    }

    if (request.action !== "send" && request.action !== "upload-file") {
      return `Error: Action "${request.action}" is not supported on X Chat.`;
    }
    if (request.action === "upload-file" && !request.mediaPath?.trim()) {
      return "Error: X Chat upload-file requires media.";
    }
    if (!request.message?.trim() && !request.mediaPath?.trim()) {
      return "Error: X Chat send requires message or media.";
    }
    if (request.replyToMessageId?.trim()) {
      return "Error: X Chat does not support explicit reply targets.";
    }

    const formatted = formatText(request.message ?? "");
    const result = await adapter.sendMessage({
      channel: "xchat",
      accountId: route.accountId,
      chatId: request.chatId,
      text: formatted.text,
      replyToMessageId: request.replyToMessageId,
      mediaPath: request.mediaPath,
      fileName: request.filename,
      title: request.title,
    });
    return request.mediaPath
      ? `Attachment sent to X Chat (message_id: ${result.messageId})`
      : `Message sent to X Chat (message_id: ${result.messageId})`;
  },
};
