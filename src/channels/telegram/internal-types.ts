import type { Bot as GrammYBot, Context as GrammYContext } from "grammy";
import type { ChannelLifecycleErrorReport } from "@/channels/lifecycle-error-report";
import type { InboundChannelMessage } from "@/channels/types";
import type { TelegramLikeMessage } from "./media";

export type TelegramBot = GrammYBot<GrammYContext>;

export type GrammYModule = typeof import("grammy") & {
  default?: Partial<typeof import("grammy")>;
};

export type TelegramBotConstructor = typeof import("grammy").Bot;

export type TelegramInputFileConstructor = typeof import("grammy").InputFile;

export type BufferedMediaGroup = {
  messages: TelegramLikeMessage[];
  timer: ReturnType<typeof setTimeout>;
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

export type TelegramRichMessageRawApi = {
  sendRichMessage(
    args: TelegramRichMessagePayload,
  ): Promise<{ message_id: string | number }>;
  sendRichMessageDraft(args: TelegramRichMessageDraftPayload): Promise<boolean>;
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

export type TelegramCallbackQuery = {
  id?: string;
  data?: string;
};

export type TelegramCallbackContext = GrammYContext & {
  callbackQuery?: TelegramCallbackQuery;
  answerCallbackQuery?: (options?: {
    text?: string;
    show_alert?: boolean;
  }) => Promise<unknown>;
};

export type TelegramLifecycleErrorReportEntry = {
  expiresAt: number;
  report: ChannelLifecycleErrorReport;
  submitted: boolean;
};

export type TelegramMentionResult = {
  isMention: boolean;
  text: string;
};

export type TelegramTypingEntry = {
  sourceKeys: Set<string>;
  timer: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
};

export type TelegramDebounceEntry = {
  inbound: InboundChannelMessage;
};
