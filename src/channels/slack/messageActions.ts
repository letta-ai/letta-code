import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
} from "../pluginTypes";
import type { SlackChannelAccount } from "../types";
import { resolveSlackMessageTarget } from "./targetResolution";

async function sendSlackMessage(
  ctx: ChannelMessageActionContext,
): Promise<string> {
  const { request, route, adapter, formatText } = ctx;
  const text = request.message ?? "";

  if (text.trim().length === 0 && !request.mediaPath) {
    return "Error: Slack send requires message or media.";
  }

  const formatted = formatText(text);
  const result = await adapter.sendMessage({
    channel: "slack",
    accountId: route.accountId,
    chatId: request.chatId,
    text: formatted.text,
    replyToMessageId: request.replyToMessageId,
    threadId: request.replyToMessageId
      ? null
      : (request.threadId ?? route.threadId ?? null),
    mediaPath: request.mediaPath,
    fileName: request.filename,
    title: request.title,
    parseMode: formatted.parseMode,
  });

  return request.mediaPath
    ? `Attachment sent to slack (message_id: ${result.messageId})`
    : `Message sent to slack (message_id: ${result.messageId})`;
}

async function reactInSlack(ctx: ChannelMessageActionContext): Promise<string> {
  const { request, route, adapter } = ctx;

  if (!request.emoji?.trim()) {
    return "Error: Slack react requires emoji.";
  }
  if (!request.messageId?.trim()) {
    return "Error: Slack react requires messageId.";
  }

  const result = await adapter.sendMessage({
    channel: "slack",
    accountId: route.accountId,
    chatId: request.chatId,
    text: "",
    targetMessageId: request.messageId,
    reaction: request.emoji,
    removeReaction: request.remove,
    threadId: request.threadId ?? route.threadId ?? null,
  });

  return request.remove
    ? `Reaction removed on slack (message_id: ${result.messageId})`
    : `Reaction added on slack (message_id: ${result.messageId})`;
}

export const slackMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool() {
    return {
      actions: ["send", "react", "upload-file"],
    };
  },

  async resolveMessageTarget(params) {
    return await resolveSlackMessageTarget({
      account: params.account as SlackChannelAccount,
      target: params.target,
    });
  },

  async handleAction(ctx) {
    switch (ctx.request.action) {
      case "send":
        return await sendSlackMessage(ctx);
      case "upload-file":
        if (!ctx.request.mediaPath?.trim()) {
          return "Error: Slack upload-file requires media.";
        }
        return await sendSlackMessage(ctx);
      case "react":
        return await reactInSlack(ctx);
      default:
        return `Error: Action "${ctx.request.action}" is not supported on slack.`;
    }
  },
};
