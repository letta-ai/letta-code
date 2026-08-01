import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
} from "@/channels/plugin-types";
import { getWhatsAppOutboundMediaValidationError } from "./media";

async function sendWhatsAppMessage(
  ctx: ChannelMessageActionContext,
): Promise<string> {
  const { request, route, adapter, formatText } = ctx;
  const text = request.message ?? "";

  if (text.trim().length === 0 && !request.mediaPath) {
    return "Error: WhatsApp send requires message or media.";
  }

  const mediaValidationError = getWhatsAppOutboundMediaValidationError({
    mediaPath: request.mediaPath,
    fileName: request.filename,
  });
  if (mediaValidationError) {
    return `Error: ${mediaValidationError}`;
  }

  const formatted = formatText(text);
  const result = await adapter.sendMessage({
    channel: "whatsapp",
    accountId: route.accountId,
    chatId: request.chatId,
    text: formatted.text,
    replyToMessageId: request.replyToMessageId,
    mediaPath: request.mediaPath,
    fileName: request.filename,
    title: request.title,
    parseMode: formatted.parseMode,
  });

  return request.mediaPath
    ? `Attachment sent to whatsapp (message_id: ${result.messageId})`
    : `Message sent to whatsapp (message_id: ${result.messageId})`;
}

async function reactInWhatsApp(
  ctx: ChannelMessageActionContext,
): Promise<string> {
  const { request, route, adapter } = ctx;

  if (!request.emoji?.trim() && !request.remove) {
    return "Error: WhatsApp react requires emoji.";
  }
  if (!request.messageId?.trim()) {
    return "Error: WhatsApp react requires messageId.";
  }

  const result = await adapter.sendMessage({
    channel: "whatsapp",
    accountId: route.accountId,
    chatId: request.chatId,
    text: "",
    targetMessageId: request.messageId,
    reaction: request.emoji,
    removeReaction: request.remove,
  });

  return request.remove
    ? `Reaction removed on whatsapp (message_id: ${result.messageId})`
    : `Reaction added on whatsapp (message_id: ${result.messageId})`;
}

export const whatsappMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool() {
    return {
      actions: ["send", "react", "upload-file"],
      schema: {
        properties: {
          media: {
            type: "string",
            description:
              "Absolute local file path to upload. Documents (.pdf, .docx, .txt) and non-voice-memo audio (.mp3, .m4a, .wav) are sent as regular file attachments — they reach the recipient as documents/audio files, not as WhatsApp push-to-talk voice notes. If you need a WhatsApp voice note, transcode to Ogg/Opus (.ogg, .oga, or .opus) upstream and send that file instead; the channel will route Ogg/Opus audio as a true voice memo.",
          },
        },
      },
    };
  },

  async handleAction(ctx) {
    switch (ctx.request.action) {
      case "send":
        return await sendWhatsAppMessage(ctx);
      case "upload-file":
        if (!ctx.request.mediaPath?.trim()) {
          return "Error: WhatsApp upload-file requires media.";
        }
        return await sendWhatsAppMessage(ctx);
      case "react":
        return await reactInWhatsApp(ctx);
      default:
        return `Error: Action "${ctx.request.action}" is not supported on whatsapp.`;
    }
  },
};
