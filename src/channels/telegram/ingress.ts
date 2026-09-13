/**
 * Pure Telegram inbound normalization shared by the local grammY adapter and
 * remote hosts (for example Cloud webhook ingress) through the public
 * `@letta-ai/letta-code/channels/telegram` subpath.
 *
 * Everything here operates on plain Bot API update shapes; no grammY import
 * and no node builtins so remote hosts reuse the exact local semantics.
 */

import type { ChannelReplyContext } from "@/channels/types";
import {
  extractTelegramMessageText,
  getTelegramSenderName,
  type TelegramLikeMessage,
  type TelegramMentionResult,
  type TelegramReactionType,
  type TelegramReactionUpdate,
} from "./message-shapes";

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getTelegramMessageEntities(
  message: TelegramLikeMessage,
): Array<{
  type?: string;
  offset?: number;
  length?: number;
}> {
  return message.text !== undefined
    ? (message.entities ?? [])
    : (message.caption_entities ?? []);
}

export function detectTelegramBotMention(
  message: TelegramLikeMessage,
  botUsername: string | null | undefined,
  botDisplayName?: string | null | undefined,
  text: string = extractTelegramMessageText(message),
): TelegramMentionResult {
  const username = botUsername?.trim().replace(/^@/, "");
  const displayName = botDisplayName?.trim();
  if (!username && !displayName) {
    return { isMention: false, text };
  }

  const mention = username ? `@${username}` : null;
  const mentionRegex = mention
    ? new RegExp(`(^|\\s)${escapeRegExp(mention)}(?=$|\\s|[,.!?;:])`, "i")
    : null;
  const entityMentioned = getTelegramMessageEntities(message).some((entity) => {
    if (!mention) return false;
    if (entity.type !== "mention") return false;
    if (
      typeof entity.offset !== "number" ||
      typeof entity.length !== "number" ||
      entity.offset < 0 ||
      entity.length <= 0
    ) {
      return false;
    }
    return (
      text.slice(entity.offset, entity.offset + entity.length).toLowerCase() ===
      mention.toLowerCase()
    );
  });
  const regexMentioned = mentionRegex?.test(text) ?? false;
  const leadingNameRegex = displayName
    ? new RegExp(
        `^\\s*${escapeRegExp(displayName)}(?:[:,]?\\s+|[,:]\\s*|$)`,
        "i",
      )
    : null;
  const leadingNameMentioned = leadingNameRegex?.test(text) ?? false;
  const isMention = entityMentioned || regexMentioned || leadingNameMentioned;
  if (!isMention) {
    return { isMention: false, text };
  }

  const leadingMentionRegex = mention
    ? new RegExp(`^\\s*${escapeRegExp(mention)}(?:[:,]?\\s*|$)`, "i")
    : null;
  const stripped = leadingMentionRegex
    ? text.replace(leadingMentionRegex, "")
    : text;
  return {
    isMention: true,
    text: leadingNameRegex
      ? stripped.replace(leadingNameRegex, "").trimStart()
      : stripped.trimStart(),
  };
}

export function getTelegramChatType(chat: {
  type?: string;
}): "direct" | "channel" {
  return !chat.type || chat.type === "private" ? "direct" : "channel";
}

export function getTelegramChatLabel(
  message: TelegramLikeMessage,
): string | undefined {
  const title = message.chat.title?.trim();
  if (title) {
    return title;
  }
  const username = message.chat.username?.trim();
  if (username) {
    return username.startsWith("@") ? username : `@${username}`;
  }
  return undefined;
}

export function getTelegramMessageThreadId(
  message: TelegramLikeMessage,
): string | null {
  return message.message_thread_id !== undefined
    ? String(message.message_thread_id)
    : null;
}

export function getTelegramReplyContext(
  message: TelegramLikeMessage,
): ChannelReplyContext | undefined {
  const replied = message.reply_to_message;
  if (!replied) {
    return undefined;
  }

  const text = extractTelegramMessageText(replied).trim();
  const context: ChannelReplyContext = {
    messageId: String(replied.message_id),
  };
  if (replied.from?.id !== undefined) {
    context.senderId = String(replied.from.id);
  }
  const senderName = getTelegramSenderName(replied);
  if (senderName) {
    context.senderName = senderName;
  }
  if (text) {
    context.text = text;
  }
  return context;
}

export function getTelegramReactionToken(
  reaction: TelegramReactionType,
): string | null {
  switch (reaction.type) {
    case "emoji":
      return reaction.emoji?.trim() || null;
    case "custom_emoji":
      return reaction.custom_emoji_id?.trim()
        ? `custom_emoji:${reaction.custom_emoji_id.trim()}`
        : null;
    case "paid":
      return "paid";
    default:
      return null;
  }
}

export function getTelegramReactionSenderName(
  update: TelegramReactionUpdate,
): string | undefined {
  if (update.user) {
    return getTelegramSenderName({
      from: update.user,
    } as TelegramLikeMessage);
  }

  if (update.actor_chat?.username?.trim()) {
    return update.actor_chat.username.trim();
  }

  if (update.actor_chat?.title?.trim()) {
    return update.actor_chat.title.trim();
  }

  return undefined;
}

export function getTelegramReactionSenderId(
  update: TelegramReactionUpdate,
): string | null {
  if (update.user?.id !== undefined) {
    return String(update.user.id);
  }
  if (update.actor_chat?.id !== undefined) {
    return String(update.actor_chat.id);
  }
  return null;
}

/**
 * Diff a Bot API `message_reaction` update into discrete added/removed
 * reaction events, using the same token normalization the local adapter uses.
 */
export function diffTelegramReactionUpdate(
  update: Pick<TelegramReactionUpdate, "old_reaction" | "new_reaction">,
): Array<{ action: "added" | "removed"; emoji: string }> {
  const oldTokens = new Set(
    update.old_reaction
      .map((reaction) => getTelegramReactionToken(reaction))
      .filter((value): value is string => typeof value === "string"),
  );
  const newTokens = new Set(
    update.new_reaction
      .map((reaction) => getTelegramReactionToken(reaction))
      .filter((value): value is string => typeof value === "string"),
  );

  const events: Array<{ action: "added" | "removed"; emoji: string }> = [];
  for (const emoji of oldTokens) {
    if (!newTokens.has(emoji)) {
      events.push({ action: "removed", emoji });
    }
  }
  for (const emoji of newTokens) {
    if (!oldTokens.has(emoji)) {
      events.push({ action: "added", emoji });
    }
  }
  return events;
}
