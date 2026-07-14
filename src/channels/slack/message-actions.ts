import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
} from "@/channels/plugin-types";
import type { SlackChannelAccount } from "@/channels/types";
import { resolveSlackMessageTarget } from "./target-resolution";

async function sendSlackMessage(
  ctx: ChannelMessageActionContext,
): Promise<string> {
  const { request, route, adapter, formatText } = ctx;
  const text = request.message ?? "";

  if (text.trim().length === 0 && !request.mediaPath) {
    return "Error: Slack send requires message or media.";
  }

  const isDirect =
    route.chatType === "direct" || request.chatId.startsWith("D");
  const formatted = formatText(text);
  const result = await adapter.sendMessage({
    channel: "slack",
    accountId: route.accountId,
    chatId: request.chatId,
    text: formatted.text,
    replyToMessageId: isDirect ? undefined : request.replyToMessageId,
    threadId: isDirect
      ? (request.threadId ?? route.threadId ?? null)
      : request.replyToMessageId
        ? null
        : (request.threadId ?? route.threadId ?? null),
    mediaPath: request.mediaPath,
    fileName: request.filename,
    title: request.title,
    parseMode: formatted.parseMode,
    agentId: route.agentId,
    conversationId: route.conversationId,
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

async function downloadSlackFile(
  ctx: ChannelMessageActionContext,
): Promise<string> {
  const { request } = ctx;
  if (!request.attachmentId?.trim()) {
    return "Error: Slack download-file requires attachmentId.";
  }
  if (!request.messageId?.trim()) {
    return "Error: Slack download-file requires messageId from the attachment's Slack context.";
  }
  if (typeof ctx.adapter.downloadAttachment !== "function") {
    return "Error: Running Slack adapter does not support attachment downloads.";
  }
  const attachment = await ctx.adapter.downloadAttachment({
    attachmentId: request.attachmentId,
    chatId: request.chatId,
    threadId: request.threadId ?? null,
    messageId: request.messageId,
  });
  if (!attachment.localPath) {
    return `Error: Slack attachment ${request.attachmentId} was not downloaded.`;
  }

  return `Slack attachment downloaded (local_path: ${attachment.localPath})`;
}

export const slackMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool() {
    return {
      actions: ["send", "react", "upload-file", "download-file"],
      schema: {
        properties: {
          attachmentId: {
            type: "string",
            description:
              "Slack attachment id for action='download-file'. Copy attachment_id from the channel notification.",
          },
          messageId: {
            type: "string",
            description:
              "Target Slack message id for action='react', or the source message id containing attachmentId for action='download-file'.",
          },
        },
      },
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
      case "download-file":
        return await downloadSlackFile(ctx);
      default:
        return `Error: Action "${ctx.request.action}" is not supported on slack.`;
    }
  },
};
