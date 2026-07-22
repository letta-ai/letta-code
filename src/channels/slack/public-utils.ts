import type {
  ChannelTurnSource,
  OutboundChannelMessage,
} from "@/channels/types";

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find(isNonEmptyString);
}

export function normalizeSlackText(text: string): string {
  return text.replace(/^(?:\s*<@[A-Z0-9]+>\s*)+/, "").trim();
}

export function resolveSlackChatType(chatId: string): "direct" | "channel" {
  return chatId.startsWith("D") ? "direct" : "channel";
}

export function resolveSlackSourceThreadTs(
  source: ChannelTurnSource,
): string | undefined {
  if (
    source.chatType === "direct" ||
    resolveSlackChatType(source.chatId) === "direct"
  ) {
    return firstNonEmptyString(source.threadId);
  }
  return firstNonEmptyString(source.threadId, source.messageId);
}

export function resolveSlackProgressThreadTs(
  source: ChannelTurnSource,
): string | undefined {
  if (
    source.chatType === "direct" ||
    resolveSlackChatType(source.chatId) === "direct"
  ) {
    return firstNonEmptyString(source.threadId, source.messageId);
  }
  return resolveSlackSourceThreadTs(source);
}

export function resolveSlackOutboundThreadTs(
  msg: Pick<OutboundChannelMessage, "chatId" | "threadId" | "replyToMessageId">,
): string | undefined {
  if (resolveSlackChatType(msg.chatId) === "direct") {
    return firstNonEmptyString(msg.threadId);
  }
  return firstNonEmptyString(msg.threadId, msg.replyToMessageId);
}

export function normalizeSlackReactionName(value: string): string {
  return value.trim().replace(/^:+|:+$/g, "");
}

export function slackTimestampToMillis(value: string): number {
  return Math.round(Number.parseFloat(value) * 1000);
}
