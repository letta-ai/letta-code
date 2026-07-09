import type SlackApp from "@slack/bolt";
import type {
  InboundChannelMessage,
  SlackChannelAccount,
} from "@/channels/types";
import {
  resolveSlackChannelHistory,
  resolveSlackCurrentMessageAttachments,
  resolveSlackThreadHistory,
  resolveSlackThreadStarter,
} from "./media";
import { asRecord, isNonEmptyString } from "./utils";

const INITIAL_SLACK_THREAD_HISTORY_LIMIT = 20;

/**
 * Slack app_mention events and thread_broadcast messages deliver their file
 * attachments inconsistently (or not at all) on the event payload, so the
 * exact message must be re-fetched to hydrate attachments before prompt
 * formatting.
 */
function shouldHydrateCurrentSlackMessageAttachments(
  msg: InboundChannelMessage,
): boolean {
  if (msg.attachments?.length || msg.chatType !== "channel") {
    return false;
  }
  const raw = asRecord(msg.raw);
  if (!raw) {
    return false;
  }
  return raw.type === "app_mention" || raw.subtype === "thread_broadcast";
}

function truncateThreadLabel(text: string, maxLength = 80): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildThreadLabel(
  msg: InboundChannelMessage,
  starterText?: string,
): string | undefined {
  const roomLabel =
    msg.chatType === "channel" &&
    isNonEmptyString(msg.chatLabel) &&
    msg.chatLabel !== msg.chatId
      ? ` in ${msg.chatLabel}`
      : "";
  const preview = truncateThreadLabel(starterText ?? msg.text);
  const threadLabel =
    msg.chatType === "direct" ? "Slack DM thread" : "Slack thread";
  if (preview) return `${threadLabel}${roomLabel}: ${preview}`;
  return roomLabel
    ? `${threadLabel}${roomLabel}`
    : `${threadLabel} ${msg.chatId}`;
}

function buildChannelContextLabel(
  msg: InboundChannelMessage,
): string | undefined {
  if (msg.chatType !== "channel") return undefined;
  const roomLabel =
    isNonEmptyString(msg.chatLabel) && msg.chatLabel !== msg.chatId
      ? ` in ${msg.chatLabel}`
      : "";
  return roomLabel
    ? `Slack channel context${roomLabel} before thread start`
    : "Slack channel context before thread start";
}

export async function prepareSlackInboundMessage(params: {
  msg: InboundChannelMessage;
  options?: { isFirstRouteTurn?: boolean };
  config: SlackChannelAccount;
  ensureApp: () => Promise<SlackApp>;
  resolveUserName: (
    app: SlackApp,
    userId: string | undefined,
  ) => Promise<string | undefined>;
  getKnownUserDisplayName: (userId: string) => string | undefined;
}): Promise<InboundChannelMessage> {
  const { msg, config } = params;
  if (
    msg.channel !== "slack" ||
    !isNonEmptyString(msg.threadId) ||
    !isNonEmptyString(msg.messageId)
  ) {
    return msg;
  }

  const isFirstRouteTurn = params.options?.isFirstRouteTurn === true;
  const isExistingThread = msg.threadId !== msg.messageId;
  const isChannelBootstrap =
    isFirstRouteTurn &&
    msg.isMention === true &&
    msg.threadId === msg.messageId;
  const shouldHydrateCurrentAttachments =
    shouldHydrateCurrentSlackMessageAttachments(msg);
  if (
    !isExistingThread &&
    !isChannelBootstrap &&
    !shouldHydrateCurrentAttachments
  ) {
    return msg;
  }

  const app = await params.ensureApp();
  const attachmentParams = {
    accountId: config.accountId,
    token: config.botToken,
    transcribeVoice: config.transcribeVoice === true,
  };
  const currentAttachments = shouldHydrateCurrentAttachments
    ? await resolveSlackCurrentMessageAttachments({
        channelId: msg.chatId,
        threadTs: msg.threadId,
        messageTs: msg.messageId,
        client: app.client,
        ...attachmentParams,
      })
    : [];
  const starter =
    isExistingThread && isFirstRouteTurn
      ? await resolveSlackThreadStarter({
          channelId: msg.chatId,
          threadTs: msg.threadId,
          client: app.client,
          ...attachmentParams,
        })
      : null;
  const resolvedHistory = isExistingThread
    ? await resolveSlackThreadHistory({
        channelId: msg.chatId,
        threadTs: msg.threadId,
        client: app.client,
        currentMessageTs: msg.messageId,
        limit: INITIAL_SLACK_THREAD_HISTORY_LIMIT,
        include: !isFirstRouteTurn ? "bot" : "all",
        ...attachmentParams,
      })
    : await resolveSlackChannelHistory({
        channelId: msg.chatId,
        beforeTs: msg.messageId,
        client: app.client,
        limit: INITIAL_SLACK_THREAD_HISTORY_LIMIT,
        ...attachmentParams,
      });
  const history = resolvedHistory;
  if (!starter && history.length === 0 && currentAttachments.length === 0) {
    return msg;
  }

  const userIds = new Set<string>();
  if (isNonEmptyString(starter?.userId)) userIds.add(starter.userId);
  for (const entry of history) {
    if (isNonEmptyString(entry.userId)) userIds.add(entry.userId);
  }
  await Promise.all(
    Array.from(userIds).map((userId) => params.resolveUserName(app, userId)),
  );

  const resolveSenderName = (
    userId?: string,
    botId?: string,
  ): string | undefined => {
    if (isNonEmptyString(userId)) {
      return params.getKnownUserDisplayName(userId) ?? userId;
    }
    return isNonEmptyString(botId) ? `Bot (${botId})` : undefined;
  };
  return {
    ...msg,
    ...(currentAttachments.length > 0
      ? { attachments: currentAttachments }
      : {}),
    threadContext: {
      label: isExistingThread
        ? buildThreadLabel(msg, starter?.text)
        : buildChannelContextLabel(msg),
      ...(starter
        ? {
            starter: {
              messageId: starter.ts,
              senderId: starter.userId ?? starter.botId,
              senderName: resolveSenderName(starter.userId, starter.botId),
              text: starter.text,
              ...(starter.attachments?.length
                ? { attachments: starter.attachments }
                : {}),
            },
          }
        : {}),
      ...(history.length
        ? {
            history: history.map((entry) => ({
              messageId: entry.ts,
              senderId: entry.userId ?? entry.botId,
              senderName: resolveSenderName(entry.userId, entry.botId),
              text: entry.text,
              ...(entry.attachments?.length
                ? { attachments: entry.attachments }
                : {}),
            })),
          }
        : {}),
    },
  };
}
