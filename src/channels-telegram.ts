/**
 * Public Telegram channel primitives for remote hosts (for example Cloud
 * webhook ingress and Bot API senders).
 *
 * Bundled as `@letta-ai/letta-code/channels/telegram`. Everything reachable
 * from this entry must stay free of grammY imports, node builtins, and
 * backend/provider modules — the same constraint as `channels/slack`.
 *
 * NOTE: use relative imports in this file (not `@/`), because tsc preserves
 * import specifiers in the emitted d.ts files and consumers cannot resolve
 * `@/` aliases.
 */

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
