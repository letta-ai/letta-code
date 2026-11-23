export {
  buildTelegramDebounceKey,
  resolveTelegramInboundDebounceMs,
  TELEGRAM_DEBOUNCE_DEFAULT_MS,
  TELEGRAM_DEBOUNCE_MAX_MS,
  type TelegramDebounceInput,
} from "./channels/telegram/debounce";
export {
  detectTelegramBotMention,
  diffTelegramReactionUpdate,
  getTelegramChatLabel,
  getTelegramChatType,
  getTelegramMessageEntities,
  getTelegramMessageThreadId,
  getTelegramReactionSenderId,
  getTelegramReactionSenderName,
  getTelegramReactionToken,
  getTelegramReplyContext,
} from "./channels/telegram/ingress";
export type { CreateTelegramMessageActionAdapterOptions } from "./channels/telegram/message-action-contract";
export { createTelegramMessageActionAdapter } from "./channels/telegram/message-action-contract";
export type {
  TelegramInputRichMessage,
  TelegramLikeMessage,
  TelegramMentionResult,
  TelegramReactionInput,
  TelegramReactionType,
  TelegramReactionUpdate,
  TelegramRichMessageDraftPayload,
  TelegramRichMessagePayload,
} from "./channels/telegram/message-shapes";
export {
  extractTelegramMessageText,
  getTelegramSenderName,
} from "./channels/telegram/message-shapes";
export {
  buildTelegramReplyOptions,
  buildTelegramRichMessageDraftPayload,
  buildTelegramRichMessagePayload,
  getTelegramErrorText,
  parseTelegramReactionInput,
  resolveTelegramOutboundThreadId,
  shouldFallbackTelegramRichMessage,
  toTelegramInputRichMessage,
} from "./channels/telegram/outbound";
