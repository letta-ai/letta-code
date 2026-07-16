import {
  firstNonEmptyString,
  isNonEmptyString,
  normalizeSlackText,
  resolveSlackChatType,
} from "./public-utils";

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

export interface ResolveSlackMessageIngressPolicyParams {
  message: SlackInboundMessageEventLike;
  botUserId?: string | null;
  isAgentThread?: boolean;
}

export interface ResolveSlackAppMentionIngressPolicyParams {
  event: SlackAppMentionEventLike;
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
}

export type SlackIngressIgnoreReason =
  | "missing_channel"
  | "missing_sender"
  | "missing_timestamp"
  | "hidden_message"
  | "ignored_subtype"
  | "wrapper_message"
  | "top_level_channel_message";

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
    text: wasMentioned ? normalizeSlackText(rawText) : rawText,
    rawText,
    wasMentioned,
    effectiveMention,
    isAgentThread,
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
    text: normalizeSlackText(rawText),
    rawText,
    wasMentioned: true,
    effectiveMention: true,
    isAgentThread: false,
  };
}
