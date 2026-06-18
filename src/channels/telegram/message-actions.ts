import { getChannelAccount } from "@/channels/accounts";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionRequest,
} from "@/channels/plugin-types";
import type { ChannelRoute } from "@/channels/types";
import { isTelegramChannelAccount } from "@/channels/types";

function richPrivateChatDefaultEnabled(route: ChannelRoute): boolean {
  const accountId = route.accountId?.trim();
  if (!accountId) {
    return true;
  }
  const account = getChannelAccount("telegram", accountId);
  if (!account || !isTelegramChannelAccount(account)) {
    return true;
  }
  return account.richPrivateChatDefault !== false;
}

function shouldSendTelegramRichMessage(params: {
  request: ChannelMessageActionRequest;
  route: ChannelRoute;
}): boolean {
  if (params.request.action === "send-rich") {
    return true;
  }
  return (
    params.request.action === "send" &&
    params.route.chatType === "direct" &&
    richPrivateChatDefaultEnabled(params.route) &&
    !params.request.mediaPath?.trim()
  );
}

function resolveTelegramRouteThreadId(
  ctx: ChannelMessageActionContext,
): string | null {
  const threadId = ctx.request.threadId ?? ctx.route.threadId ?? null;
  const trimmed = threadId?.trim();
  if (!trimmed) {
    return null;
  }

  if (ctx.route.chatType === "direct") {
    return null;
  }

  return ctx.route.chatId.trim().startsWith("-") ? trimmed : null;
}

export const telegramMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool() {
    return {
      actions: ["send", "send-rich", "react", "upload-file"],
    };
  },

  async handleAction(ctx) {
    const { request, route, adapter, formatText } = ctx;

    if (
      request.action !== "send" &&
      request.action !== "send-rich" &&
      request.action !== "react" &&
      request.action !== "upload-file"
    ) {
      return `Error: Action "${request.action}" is not supported on telegram.`;
    }
    if (request.action === "react") {
      if (!request.emoji?.trim() && !request.remove) {
        return "Error: Telegram react requires emoji.";
      }
      if (!request.messageId?.trim()) {
        return "Error: Telegram react requires messageId.";
      }

      const result = await adapter.sendMessage({
        channel: "telegram",
        accountId: route.accountId,
        chatId: request.chatId,
        text: "",
        targetMessageId: request.messageId,
        reaction: request.emoji,
        removeReaction: request.remove,
      });

      return request.remove
        ? `Reaction removed on telegram (message_id: ${result.messageId})`
        : `Reaction added on telegram (message_id: ${result.messageId})`;
    }

    if (request.action === "send-rich") {
      if (!request.message?.trim()) {
        return "Error: Telegram send-rich requires message.";
      }
      if (request.mediaPath?.trim()) {
        return "Error: Telegram send-rich does not support local media uploads; use upload-file instead.";
      }
    }
    if (!request.message?.trim() && !request.mediaPath?.trim()) {
      return "Error: Telegram send requires message or media.";
    }
    if (request.action === "upload-file" && !request.mediaPath?.trim()) {
      return "Error: Telegram upload-file requires media.";
    }
    if (request.action === "send" && !request.message?.trim()) {
      return "Error: Telegram send requires message.";
    }

    const formatted = formatText(request.message ?? "");
    const sendRichMessage = shouldSendTelegramRichMessage({ request, route });
    const result = await adapter.sendMessage({
      channel: "telegram",
      accountId: route.accountId,
      chatId: request.chatId,
      text: formatted.text,
      replyToMessageId: request.replyToMessageId,
      threadId: resolveTelegramRouteThreadId(ctx),
      mediaPath: request.mediaPath,
      fileName: request.filename,
      title: request.title,
      parseMode: formatted.parseMode,
      ...(sendRichMessage
        ? { richMessage: { markdown: request.message ?? "" } }
        : {}),
    });

    return request.mediaPath
      ? `Attachment sent to telegram (message_id: ${result.messageId})`
      : `Message sent to telegram (message_id: ${result.messageId})`;
  },
};
