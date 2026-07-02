import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
} from "@/channels/plugin-types";

async function sendSignalMessage(
  ctx: ChannelMessageActionContext,
): Promise<string> {
  const { request, route, adapter, formatText } = ctx;
  const text = request.message ?? "";

  if (text.trim().length === 0 && !request.mediaPath) {
    return "Error: Signal send requires message or media.";
  }

  const formatted = formatText(text);
  const result = await adapter.sendMessage({
    channel: "signal",
    accountId: route.accountId,
    chatId: request.chatId,
    text: formatted.text,
    replyToMessageId: request.replyToMessageId,
    mediaPath: request.mediaPath,
    fileName: request.filename,
    title: request.title,
    parseMode: formatted.parseMode,
    textStyle: formatted.textStyle,
  });

  return request.mediaPath
    ? `Attachment sent to signal (message_id: ${result.messageId})`
    : `Message sent to signal (message_id: ${result.messageId})`;
}

async function reactInSignal(
  ctx: ChannelMessageActionContext,
): Promise<string> {
  const { request, route, adapter } = ctx;

  if (!request.emoji?.trim() && !request.remove) {
    return "Error: Signal react requires emoji.";
  }
  if (!request.messageId?.trim()) {
    return "Error: Signal react requires messageId. Use the messageId from a Signal inbound message because Signal reactions need the target author as well as the timestamp.";
  }

  const result = await adapter.sendMessage({
    channel: "signal",
    accountId: route.accountId,
    chatId: request.chatId,
    text: "",
    targetMessageId: request.messageId,
    reaction: request.emoji,
    removeReaction: request.remove,
  });

  return request.remove
    ? `Reaction removed on signal (message_id: ${result.messageId})`
    : `Reaction added on signal (message_id: ${result.messageId})`;
}

export const signalMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool() {
    return {
      actions: ["send", "react", "upload-file"],
      schema: {
        properties: {
          media: {
            type: "string",
            description:
              "Absolute local file path to send through Signal as an attachment. The signal-cli-rest-api daemon must be able to read this path.",
          },
          messageId: {
            type: "string",
            description:
              "Target message id for reactions. On Signal, use the messageId from an inbound Signal notification; it encodes the target timestamp and author required by signal-cli.",
          },
        },
      },
    };
  },

  async handleAction(ctx) {
    switch (ctx.request.action) {
      case "send":
        return await sendSignalMessage(ctx);
      case "upload-file":
        if (!ctx.request.mediaPath?.trim()) {
          return "Error: Signal upload-file requires media.";
        }
        return await sendSignalMessage(ctx);
      case "react":
        return await reactInSignal(ctx);
      default:
        return `Error: Action "${ctx.request.action}" is not supported on signal.`;
    }
  },
};
