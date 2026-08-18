/**
 * Pure Telegram wire shapes shared by the local grammY adapter and remote
 * hosts (for example Cloud webhook ingress) through the public
 * `@letta-ai/letta-code/channels/telegram` subpath.
 *
 * This module must stay free of grammY imports and node builtins so the
 * public bundle and its declaration files resolve for browser/node consumers
 * that do not install the Telegram runtime.
 */

export type TelegramLikeMessage = {
  media_group_id?: string;
  message_thread_id?: number | string;
  message_id: number | string;
  date: number;
  text?: string;
  caption?: string;
  entities?: Array<{
    type?: string;
    offset?: number;
    length?: number;
  }>;
  caption_entities?: Array<{
    type?: string;
    offset?: number;
    length?: number;
  }>;
  reply_to_message?: TelegramLikeMessage;
  chat: {
    id: number | string;
    type?: string;
    title?: string;
    username?: string;
  };
  from?: {
    id: number | string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  photo?: Array<{
    file_id: string;
    file_unique_id?: string;
    file_size?: number;
  }>;
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  video?: {
    file_id: string;
    file_name?: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
  };
  audio?: {
    file_id: string;
    file_name?: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
  };
  voice?: {
    file_id: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
  };
  animation?: {
    file_id: string;
    file_name?: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
  };
  sticker?: {
    file_id: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
    is_animated?: boolean;
    is_video?: boolean;
  };
};

export type TelegramMentionResult = {
  isMention: boolean;
  text: string;
};

export type TelegramInputRichMessage = {
  html?: string;
  markdown?: string;
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
};

export type TelegramRichMessagePayload = {
  chat_id: string | number;
  message_thread_id?: number;
  reply_parameters?: { message_id: number };
  rich_message: TelegramInputRichMessage;
};

export type TelegramRichMessageDraftPayload = Omit<
  TelegramRichMessagePayload,
  "reply_parameters"
> & {
  draft_id: number;
};

export type TelegramReactionType =
  | {
      type?: "emoji";
      emoji?: string;
    }
  | {
      type?: "custom_emoji";
      custom_emoji_id?: string;
    }
  | {
      type?: "paid";
    };

/**
 * Structural reaction payload accepted by Bot API `setMessageReaction`.
 * Mirrors grammY's `ReactionType` without importing its types so the public
 * declaration files do not require `@grammyjs/types`.
 */
export type TelegramReactionInput =
  | {
      type: "emoji";
      emoji: string;
    }
  | {
      type: "custom_emoji";
      custom_emoji_id: string;
    };

export type TelegramReactionUpdate = {
  chat: {
    id: string | number;
    type?: string;
    title?: string;
    username?: string;
  };
  message_id: string | number;
  user?: {
    id: string | number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  actor_chat?: {
    id: string | number;
    username?: string;
    title?: string;
  };
  date: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
};

export function extractTelegramMessageText(
  message: TelegramLikeMessage,
): string {
  if (typeof message.text === "string") {
    return message.text;
  }
  if (typeof message.caption === "string") {
    return message.caption;
  }
  return "";
}

export function getTelegramSenderName(
  message: TelegramLikeMessage,
): string | undefined {
  if (!message.from) {
    return undefined;
  }

  return (
    message.from.username ??
    ([message.from.first_name, message.from.last_name]
      .filter(Boolean)
      .join(" ") ||
      undefined)
  );
}
