/**
 * Pure Telegram outbound payload builders shared by the local grammY adapter
 * and remote hosts (for example Cloud Bot API senders) through the public
 * `@letta-ai/letta-code/channels/telegram` subpath.
 *
 * Everything here builds plain Bot API payload objects; no grammY import and
 * no node builtins.
 */

import type {
  ChannelRichMessage,
  OutboundChannelMessage,
  OutboundChannelRichMessageDraft,
} from "@/channels/types";
import type {
  TelegramInputRichMessage,
  TelegramReactionInput,
  TelegramRichMessageDraftPayload,
  TelegramRichMessagePayload,
} from "./message-shapes";

export function resolveTelegramOutboundThreadId(msg: {
  threadId?: string | null;
}): string | null {
  return msg.threadId?.trim() || null;
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

export function parseTelegramReactionInput(
  reaction: string,
): TelegramReactionInput | null {
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
    emoji: trimmed,
  };
}
