import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
} from "@/channels/plugin-types";

export interface CreateSlackMessageActionAdapterOptions {
  /** Expose reaction actions when the injected transport supports them. */
  react?: boolean;
  /** Expose local-path uploads when the injected transport can read them. */
  uploadFile?: boolean;
  /** Host-owned proactive target resolver, when proactive sends are supported. */
  resolveMessageTarget?: ChannelMessageActionAdapter["resolveMessageTarget"];
  /** Host-owned attachment materialization, when download-file is supported. */
  downloadFile?: (context: ChannelMessageActionContext) => Promise<string>;
}

async function sendSlackMessage(
  context: ChannelMessageActionContext,
): Promise<string> {
  const { request, route, adapter, formatText } = context;
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

async function reactInSlack(
  context: ChannelMessageActionContext,
): Promise<string> {
  const { request, route, adapter } = context;
  if (!request.emoji?.trim()) return "Error: Slack react requires emoji.";
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

/**
 * Build canonical Slack MessageChannel actions around a host-owned transport.
 * Capabilities are explicit so remote gateways never advertise local-path or
 * attachment behavior they cannot execute.
 */
export function createSlackMessageActionAdapter(
  options: CreateSlackMessageActionAdapterOptions = {},
): ChannelMessageActionAdapter {
  const actions = [
    "send",
    ...(options.react ? ["react"] : []),
    ...(options.uploadFile ? ["upload-file"] : []),
    ...(options.downloadFile ? ["download-file"] : []),
  ];
  return {
    describeMessageTool() {
      const properties: Record<string, unknown> = {};
      if (options.downloadFile) {
        properties.attachmentId = {
          type: "string",
          description:
            "Slack attachment id for action='download-file'. Copy attachment_id from the channel notification.",
        };
      }
      if (options.react || options.downloadFile) {
        properties.messageId = {
          type: "string",
          description: options.downloadFile
            ? "Target Slack message id for action='react', or the source message id containing attachmentId for action='download-file'."
            : "Target Slack message id for action='react'.",
        };
      }
      return {
        actions: [...actions],
        ...(Object.keys(properties).length > 0
          ? { schema: { properties } }
          : {}),
      };
    },
    ...(options.resolveMessageTarget
      ? { resolveMessageTarget: options.resolveMessageTarget }
      : {}),
    async handleAction(context) {
      switch (context.request.action) {
        case "send":
          return await sendSlackMessage(context);
        case "upload-file":
          if (!options.uploadFile) {
            return 'Error: Action "upload-file" is not supported on slack.';
          }
          if (!context.request.mediaPath?.trim()) {
            return "Error: Slack upload-file requires media.";
          }
          return await sendSlackMessage(context);
        case "react":
          return options.react
            ? await reactInSlack(context)
            : 'Error: Action "react" is not supported on slack.';
        case "download-file":
          return options.downloadFile
            ? await options.downloadFile(context)
            : 'Error: Action "download-file" is not supported on slack.';
        default:
          return `Error: Action "${context.request.action}" is not supported on slack.`;
      }
    },
  };
}
