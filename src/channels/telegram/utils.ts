import { formatChannelLifecycleErrorMessage } from "@/channels/lifecycle-error";
import type { ChannelTurnOutcome, ChannelTurnSource } from "@/channels/types";
import type {
  GrammYModule,
  TelegramBotConstructor,
  TelegramInputFileConstructor,
} from "./internal-types";

export {
  detectTelegramBotMention,
  escapeRegExp,
  getTelegramChatLabel,
  getTelegramChatType,
  getTelegramMessageEntities,
  getTelegramMessageThreadId,
  getTelegramReactionSenderId,
  getTelegramReactionSenderName,
  getTelegramReactionToken,
  getTelegramReplyContext,
} from "./ingress";
export {
  buildTelegramReplyOptions,
  buildTelegramRichMessageDraftPayload,
  buildTelegramRichMessagePayload,
  getTelegramErrorText,
  parseTelegramReactionInput,
  resolveTelegramOutboundThreadId,
  shouldFallbackTelegramRichMessage,
  toTelegramInputRichMessage,
} from "./outbound";

export const TELEGRAM_LIFECYCLE_ERROR_TEXT_MAX = 3500;

export const TELEGRAM_LIFECYCLE_ERROR_DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;

export const TELEGRAM_LIFECYCLE_ERROR_DEDUPE_MAX = 1000;

export const TELEGRAM_LIFECYCLE_ERROR_REPORT_TTL_MS = 6 * 60 * 60 * 1000;

export const TELEGRAM_LIFECYCLE_ERROR_REPORT_MAX = 1000;

export const TELEGRAM_REPORT_CALLBACK_PREFIX = "lc_report:";

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

export function getTelegramLifecycleErrorReplyKey(
  source: ChannelTurnSource,
  options: {
    accountId: string;
    batchId: string;
    outcome: ChannelTurnOutcome;
    runId?: string | null;
  },
): string | null {
  if (source.channel !== "telegram" || !source.chatId) {
    return null;
  }
  return [
    options.accountId,
    source.chatId,
    source.threadId?.trim() ?? "",
    options.runId?.trim() || options.batchId,
    options.outcome,
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

// Lifecycle events own normal cleanup. This remains only as a lost-terminal
// backstop; the controller slides it on activity so a healthy long turn is not
// measured from first start.
export const TELEGRAM_TYPING_MAX_MS = 6 * 60 * 60 * 1000;
