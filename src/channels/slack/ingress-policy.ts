import {
  firstNonEmptyString,
  isNonEmptyString,
  resolveSlackChatType,
} from "./public-utils";
import { stripSlackBotMention } from "./user-mentions";

const IGNORED_SLACK_MESSAGE_SUBTYPES = new Set([
  "assistant_app_thread",
  "channel_archive",
  "channel_convert_to_private",
  "channel_convert_to_public",
  "channel_join",
  "channel_leave",
  "channel_name",
  "channel_posting_permissions",
  "channel_purpose",
  "channel_topic",
  "channel_unarchive",
  "document_mention",
  "ekm_access_denied",
  "file_comment",
  "group_archive",
  "group_join",
  "group_leave",
  "group_name",
  "group_purpose",
  "group_topic",
  "group_unarchive",
  "pinned_item",
  "reminder_add",
  "unpinned_item",
]);

const WRAPPER_SLACK_MESSAGE_SUBTYPES = new Set([
  "message_changed",
  "message_deleted",
  "message_replied",
]);

export interface SlackInboundMessageEventLike {
  channel?: unknown;
  user?: unknown;
  bot_id?: unknown;
  ts?: unknown;
  text?: unknown;
  thread_ts?: unknown;
  subtype?: unknown;
  hidden?: boolean;
  message?: unknown;
}

export interface SlackAppMentionEventLike {
  channel?: unknown;
  user?: unknown;
  bot_id?: unknown;
  ts?: unknown;
  text?: unknown;
  thread_ts?: unknown;
}

export interface SlackReactionEventLike {
  user?: unknown;
  item_user?: unknown;
  reaction?: unknown;
  event_ts?: unknown;
  item?: unknown;
}

export interface ResolveSlackMessageIngressPolicyParams {
  message: SlackInboundMessageEventLike;
  botUserId?: string | null;
  isAgentThread?: boolean;
  appMentionEventWillHandleMentions?: boolean;
}

export interface ResolveSlackAppMentionIngressPolicyParams {
  event: SlackAppMentionEventLike;
  botUserId?: string | null;
}

export interface ResolveSlackReactionIngressPolicyParams {
  event: SlackReactionEventLike;
  action: "added" | "removed";
  botUserId?: string | null;
  mentionOnlyChannels?: readonly string[];
  threadId?: string | null;
}

export interface SlackMessageIngressAccepted {
  shouldRoute: true;
  channelId: string;
  senderId: string;
  senderUserId?: string;
  senderBotId?: string;
  messageId: string;
  threadId: string | null;
  chatType: "direct" | "channel";
  text: string;
  rawText: string;
  wasMentioned: boolean;
  effectiveMention: boolean;
  isAgentThread: boolean;
  routedBy: "mention" | "dm" | "thread";
}

export interface SlackAppMentionIngressAccepted {
  shouldRoute: true;
  channelId: string;
  senderId: string;
  senderUserId?: string;
  senderBotId?: string;
  messageId: string;
  threadId: string;
  chatType: "channel";
  text: string;
  rawText: string;
  wasMentioned: true;
  effectiveMention: true;
  isAgentThread: false;
  routedBy: "mention";
}

export interface SlackReactionIngressAccepted {
  shouldRoute: true;
  channelId: string;
  senderId: string;
  messageId: string;
  threadId: string | null;
  chatType: "direct" | "channel";
  text: string;
  reaction: {
    action: "added" | "removed";
    emoji: string;
    targetMessageId: string;
    targetSenderId?: string;
  };
}

export type SlackIngressIgnoreReason =
  | "missing_channel"
  | "missing_sender"
  | "missing_timestamp"
  | "hidden_message"
  | "ignored_subtype"
  | "wrapper_message"
  | "top_level_channel_message"
  | "handled_by_app_mention"
  | "invalid_reaction_item"
  | "missing_reaction"
  | "own_bot_reaction"
  | "mention_only_channel";

export interface SlackIngressIgnored {
  shouldRoute: false;
  reason: SlackIngressIgnoreReason;
}

export type SlackMessageIngressPolicy =
  | SlackMessageIngressAccepted
  | SlackIngressIgnored;

export type SlackAppMentionIngressPolicy =
  | SlackAppMentionIngressAccepted
  | SlackIngressIgnored;

export type SlackReactionIngressPolicy =
  | SlackReactionIngressAccepted
  | SlackIngressIgnored;

export function isSlackMentionOnlyChannel(
  channelId: string,
  mentionOnlyChannels: readonly string[] | undefined,
): boolean {
  return mentionOnlyChannels?.includes(channelId) === true;
}

function hasRecordValue(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

function hasSlackMention(
  text: string,
  userId: string | null | undefined,
): boolean {
  return (
    isNonEmptyString(text) &&
    isNonEmptyString(userId) &&
    (text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`))
  );
}

function isBotAuthoredMessage(message: SlackInboundMessageEventLike): boolean {
  return isNonEmptyString(message.bot_id) || message.subtype === "bot_message";
}

function resolveMessageSubtypeIgnoreReason(
  message: SlackInboundMessageEventLike,
): SlackIngressIgnoreReason | null {
  const subtype = isNonEmptyString(message.subtype) ? message.subtype : null;
  if (!subtype) {
    return null;
  }
  if (IGNORED_SLACK_MESSAGE_SUBTYPES.has(subtype)) {
    return "ignored_subtype";
  }
  if (
    WRAPPER_SLACK_MESSAGE_SUBTYPES.has(subtype) &&
    hasRecordValue(message.message)
  ) {
    return "wrapper_message";
  }
  return null;
}

export function isProcessableSlackInboundMessage(
  message: SlackInboundMessageEventLike,
): boolean {
  return resolveSlackMessageIngressPolicy({ message }).shouldRoute;
}

export function shouldSkipSlackMessageByLastSeen(params: {
  lastSeenMessageTs?: string | null;
  messageTs: string;
}): boolean {
  return Boolean(
    params.lastSeenMessageTs && params.lastSeenMessageTs >= params.messageTs,
  );
}

export function resolveSlackMessageIngressPolicy(
  params: ResolveSlackMessageIngressPolicyParams,
): SlackMessageIngressPolicy {
  const { message } = params;
  if (!isNonEmptyString(message.channel)) {
    return { shouldRoute: false, reason: "missing_channel" };
  }
  const senderId = firstNonEmptyString(message.user, message.bot_id);
  if (!senderId) {
    return { shouldRoute: false, reason: "missing_sender" };
  }
  if (!isNonEmptyString(message.ts)) {
    return { shouldRoute: false, reason: "missing_timestamp" };
  }
  if (message.hidden === true) {
    return { shouldRoute: false, reason: "hidden_message" };
  }

  const subtypeIgnoreReason = resolveMessageSubtypeIgnoreReason(message);
  if (subtypeIgnoreReason) {
    return { shouldRoute: false, reason: subtypeIgnoreReason };
  }

  const chatType = resolveSlackChatType(message.channel);
  const threadId =
    chatType === "direct"
      ? (firstNonEmptyString(message.thread_ts) ?? null)
      : (firstNonEmptyString(message.thread_ts, message.ts) ?? null);

  if (chatType === "channel" && !isNonEmptyString(message.thread_ts)) {
    return { shouldRoute: false, reason: "top_level_channel_message" };
  }

  const rawText = isNonEmptyString(message.text) ? message.text : "";
  const wasMentioned = hasSlackMention(rawText, params.botUserId);
  if (
    chatType === "channel" &&
    wasMentioned &&
    params.appMentionEventWillHandleMentions === true
  ) {
    return { shouldRoute: false, reason: "handled_by_app_mention" };
  }
  const isAgentThread = params.isAgentThread === true;
  const effectiveMention = isBotAuthoredMessage(message)
    ? wasMentioned
    : wasMentioned || isAgentThread;

  return {
    shouldRoute: true,
    channelId: message.channel,
    senderId,
    ...(isNonEmptyString(message.user) ? { senderUserId: message.user } : {}),
    ...(isNonEmptyString(message.bot_id)
      ? { senderBotId: message.bot_id }
      : {}),
    messageId: message.ts,
    threadId,
    chatType,
    text: wasMentioned
      ? stripSlackBotMention(rawText, params.botUserId)
      : rawText,
    rawText,
    wasMentioned,
    effectiveMention,
    isAgentThread,
    routedBy: wasMentioned
      ? "mention"
      : chatType === "direct"
        ? "dm"
        : "thread",
  };
}

export function resolveSlackAppMentionIngressPolicy(
  params: ResolveSlackAppMentionIngressPolicyParams,
): SlackAppMentionIngressPolicy {
  const { event } = params;
  if (!isNonEmptyString(event.channel)) {
    return { shouldRoute: false, reason: "missing_channel" };
  }
  const senderId = firstNonEmptyString(event.user, event.bot_id);
  if (!senderId) {
    return { shouldRoute: false, reason: "missing_sender" };
  }
  if (!isNonEmptyString(event.ts)) {
    return { shouldRoute: false, reason: "missing_timestamp" };
  }

  const rawText = isNonEmptyString(event.text) ? event.text : "";
  return {
    shouldRoute: true,
    channelId: event.channel,
    senderId,
    ...(isNonEmptyString(event.user) ? { senderUserId: event.user } : {}),
    ...(isNonEmptyString(event.bot_id) ? { senderBotId: event.bot_id } : {}),
    messageId: event.ts,
    threadId: firstNonEmptyString(event.thread_ts, event.ts) ?? event.ts,
    chatType: "channel",
    text: stripSlackBotMention(rawText, params.botUserId),
    rawText,
    wasMentioned: true,
    effectiveMention: true,
    isAgentThread: false,
    routedBy: "mention",
  };
}

export function resolveSlackReactionIngressPolicy(
  params: ResolveSlackReactionIngressPolicyParams,
): SlackReactionIngressPolicy {
  const item = hasRecordValue(params.event.item)
    ? (params.event.item as Record<string, unknown>)
    : null;
  if (item?.type !== "message") {
    return { shouldRoute: false, reason: "invalid_reaction_item" };
  }
  if (!isNonEmptyString(item.channel)) {
    return { shouldRoute: false, reason: "missing_channel" };
  }
  if (!isNonEmptyString(params.event.user)) {
    return { shouldRoute: false, reason: "missing_sender" };
  }
  if (!isNonEmptyString(item.ts)) {
    return { shouldRoute: false, reason: "missing_timestamp" };
  }
  if (!isNonEmptyString(params.event.reaction)) {
    return { shouldRoute: false, reason: "missing_reaction" };
  }
  if (params.event.user === params.botUserId) {
    return { shouldRoute: false, reason: "own_bot_reaction" };
  }

  const chatType = resolveSlackChatType(item.channel);
  if (
    chatType === "channel" &&
    isSlackMentionOnlyChannel(item.channel, params.mentionOnlyChannels)
  ) {
    return { shouldRoute: false, reason: "mention_only_channel" };
  }

  const targetMessageId = item.ts;
  const threadId =
    params.threadId !== undefined
      ? params.threadId
      : chatType === "channel"
        ? targetMessageId
        : null;
  const eventTimestamp =
    firstNonEmptyString(params.event.event_ts, targetMessageId) ??
    targetMessageId;
  const reaction = {
    action: params.action,
    emoji: params.event.reaction,
    targetMessageId,
    ...(isNonEmptyString(params.event.item_user)
      ? { targetSenderId: params.event.item_user }
      : {}),
  };
  return {
    shouldRoute: true,
    channelId: item.channel,
    senderId: params.event.user,
    messageId: eventTimestamp,
    threadId,
    chatType,
    text: `Slack reaction ${params.action}: :${params.event.reaction}:`,
    reaction,
  };
}
