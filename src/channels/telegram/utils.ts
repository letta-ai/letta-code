import type { ReactionType, ReactionTypeEmoji } from "@grammyjs/types";
import { formatChannelLifecycleErrorMessage } from "@/channels/lifecycle-error";
import type {
  ChannelReplyContext,
  ChannelRichMessage,
  ChannelTurnSource,
  OutboundChannelMessage,
  OutboundChannelRichMessageDraft,
} from "@/channels/types";
import type {
  GrammYModule,
  TelegramBotConstructor,
  TelegramInputFileConstructor,
  TelegramInputRichMessage,
  TelegramMentionResult,
  TelegramReactionType,
  TelegramReactionUpdate,
  TelegramRichMessageDraftPayload,
  TelegramRichMessagePayload,
} from "./internal-types";
import {
  extractTelegramMessageText,
  getTelegramSenderName,
  type TelegramLikeMessage,
} from "./media";

export const TELEGRAM_LIFECYCLE_ERROR_TEXT_MAX = 3500;

export const TELEGRAM_LIFECYCLE_ERROR_DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;

export const TELEGRAM_LIFECYCLE_ERROR_DEDUPE_MAX = 1000;

export const TELEGRAM_LIFECYCLE_ERROR_REPORT_TTL_MS = 6 * 60 * 60 * 1000;

export const TELEGRAM_LIFECYCLE_ERROR_REPORT_MAX = 1000;

export const TELEGRAM_REPORT_CALLBACK_PREFIX = "lc_report:";

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

export function resolveTelegramBotConstructor(
  mod: GrammYModule,
): TelegramBotConstructor {
  const Bot = mod.Bot ?? mod.default?.Bot;
  if (!Bot) {
    throw new Error('Installed Telegram runtime did not export "Bot".');
  }
  return Bot as TelegramBotConstructor;
}

export function resolveTelegramInputFileConstructor(
  mod: GrammYModule,
): TelegramInputFileConstructor {
  const InputFile = mod.InputFile ?? mod.default?.InputFile;
  if (!InputFile) {
    throw new Error('Installed Telegram runtime did not export "InputFile".');
  }
  return InputFile as TelegramInputFileConstructor;
}

export function resolveTelegramOutboundThreadId(
  msg: Pick<OutboundChannelMessage, "chatId" | "threadId">,
): string | null {
  const threadId = msg.threadId?.trim();
  if (!threadId) {
    return null;
  }

  // Telegram message_thread_id is only valid for forum topics in groups and
  // supergroups. Private chat IDs are positive, so never attach a thread id
  // there even if stale route state provided one.
  return msg.chatId.trim().startsWith("-") ? threadId : null;
}

export function buildTelegramReplyOptions(
  msg: Pick<
    OutboundChannelMessage,
    "chatId" | "replyToMessageId" | "threadId" | "parseMode" | "text" | "title"
  >,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const threadId = resolveTelegramOutboundThreadId(msg);
  if (threadId) {
    options.message_thread_id = Number(threadId);
  }
  if (msg.replyToMessageId) {
    options.reply_parameters = {
      message_id: Number(msg.replyToMessageId),
    };
  }
  if (msg.text.trim().length > 0) {
    options.caption = msg.text;
    if (msg.parseMode) {
      options.parse_mode = msg.parseMode;
    }
  }
  if (msg.title?.trim()) {
    options.title = msg.title.trim();
  }
  return options;
}

export function toTelegramInputRichMessage(
  richMessage: ChannelRichMessage,
): TelegramInputRichMessage {
  const html = richMessage.html?.trim() ? richMessage.html : undefined;
  const markdown = richMessage.markdown?.trim()
    ? richMessage.markdown
    : undefined;

  if (!html && !markdown) {
    throw new Error("Telegram rich messages require html or markdown content.");
  }
  if (html && markdown) {
    throw new Error(
      "Telegram rich messages require exactly one of html or markdown.",
    );
  }

  const input: TelegramInputRichMessage = html ? { html } : { markdown };
  if (richMessage.isRtl !== undefined) {
    input.is_rtl = richMessage.isRtl;
  }
  if (richMessage.skipEntityDetection !== undefined) {
    input.skip_entity_detection = richMessage.skipEntityDetection;
  }
  return input;
}

export function buildTelegramRichMessagePayload(
  msg: Pick<
    OutboundChannelMessage,
    "chatId" | "replyToMessageId" | "threadId" | "richMessage"
  >,
): TelegramRichMessagePayload {
  if (!msg.richMessage) {
    throw new Error("Telegram rich message payload missing richMessage.");
  }

  const payload: TelegramRichMessagePayload = {
    chat_id: msg.chatId,
    rich_message: toTelegramInputRichMessage(msg.richMessage),
  };
  const threadId = resolveTelegramOutboundThreadId(msg);
  if (threadId) {
    payload.message_thread_id = Number(threadId);
  }
  if (msg.replyToMessageId) {
    payload.reply_parameters = {
      message_id: Number(msg.replyToMessageId),
    };
  }
  return payload;
}

export function buildTelegramRichMessageDraftPayload(
  draft: Pick<
    OutboundChannelRichMessageDraft,
    "chatId" | "threadId" | "draftId" | "richMessage"
  >,
): TelegramRichMessageDraftPayload {
  const payload: TelegramRichMessageDraftPayload = {
    chat_id: draft.chatId,
    draft_id: draft.draftId,
    rich_message: toTelegramInputRichMessage(draft.richMessage),
  };
  const threadId = resolveTelegramOutboundThreadId(draft);
  if (threadId) {
    payload.message_thread_id = Number(threadId);
  }
  return payload;
}

export function getTelegramErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    const maybeError = error as { message?: unknown; description?: unknown };
    if (typeof maybeError.description === "string") {
      return maybeError.description;
    }
    if (typeof maybeError.message === "string") {
      return maybeError.message;
    }
  }
  return String(error);
}

export function shouldFallbackTelegramRichMessage(error: unknown): boolean {
  const text = getTelegramErrorText(error).toLowerCase();
  if (text.includes("message thread") || text.includes("thread not found")) {
    return false;
  }
  const mentionsRichMessage =
    text.includes("sendrichmessage") ||
    text.includes("rich message") ||
    text.includes("rich_message");
  const mentionsRichFormatting =
    mentionsRichMessage ||
    text.includes("markdown") ||
    text.includes("html") ||
    text.includes("entity") ||
    text.includes("entities");

  if (text.includes("unsupported")) {
    return true;
  }
  if (
    text.includes("not found") &&
    (text.includes("404") || text.includes("method"))
  ) {
    return true;
  }
  if (text.includes("can't parse") || text.includes("cannot parse")) {
    return true;
  }
  if (mentionsRichFormatting && text.includes("parse")) {
    return true;
  }
  if (mentionsRichFormatting && text.includes("invalid")) {
    return true;
  }
  return mentionsRichMessage && text.includes("bad request");
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

export function parseTelegramReactionInput(
  reaction: string,
): ReactionType | null {
  const trimmed = reaction.trim();
  if (!trimmed) {
    return null;
  }

  const customEmojiPrefix = "custom_emoji:";
  if (trimmed.startsWith(customEmojiPrefix)) {
    const customEmojiId = trimmed.slice(customEmojiPrefix.length).trim();
    if (!customEmojiId) {
      return null;
    }
    return {
      type: "custom_emoji",
      custom_emoji_id: customEmojiId,
    };
  }

  return {
    type: "emoji",
    emoji: trimmed as ReactionTypeEmoji["emoji"],
  };
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

export function getTelegramLifecycleErrorReplyKey(
  source: ChannelTurnSource,
): string | null {
  if (source.channel !== "telegram" || !source.chatId) {
    return null;
  }
  return [
    source.chatId,
    source.threadId ?? source.messageId ?? "",
    source.conversationId,
  ].join(":");
}

export function formatTelegramLifecycleErrorMessage(
  errorText: string,
  runId?: string | null,
): string {
  return formatChannelLifecycleErrorMessage(errorText, {
    maxLength: TELEGRAM_LIFECYCLE_ERROR_TEXT_MAX,
    runId,
  });
}

export const TELEGRAM_TYPING_REFRESH_MS = 4_000;

export const TELEGRAM_TYPING_MAX_MS = 5 * 60 * 1000;
