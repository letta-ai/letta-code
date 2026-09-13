import type { Bot as GrammYBot, Context as GrammYContext } from "grammy";
import type { ChannelLifecycleErrorReport } from "@/channels/lifecycle-error-report";
import type { InboundChannelMessage } from "@/channels/types";
import type {
  TelegramLikeMessage,
  TelegramRichMessageDraftPayload,
  TelegramRichMessagePayload,
} from "./message-shapes";

export type {
  TelegramInputRichMessage,
  TelegramMentionResult,
  TelegramReactionType,
  TelegramReactionUpdate,
  TelegramRichMessageDraftPayload,
  TelegramRichMessagePayload,
} from "./message-shapes";

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

export type TelegramRichMessageRawApi = {
  sendRichMessage(
    args: TelegramRichMessagePayload,
  ): Promise<{ message_id: string | number }>;
  sendRichMessageDraft(args: TelegramRichMessageDraftPayload): Promise<boolean>;
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

export type TelegramTypingEntry = {
  sourceKeys: Set<string>;
  timer: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
};

export type TelegramDebounceEntry = {
  inbound: InboundChannelMessage;
};
