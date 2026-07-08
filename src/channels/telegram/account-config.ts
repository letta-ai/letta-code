import type { ChannelAccountConfigAdapter } from "@/channels/plugin-types";
import type {
  TelegramChannelAccount,
  TelegramGroupMode,
} from "@/channels/types";

const TELEGRAM_CONFIG_KEYS = new Set([
  "token",
  "group_mode",
  "transcribe_voice",
  "rich_private_chat_default",
  "rich_draft_streaming",
  "inbound_debounce_ms",
]);

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isTelegramGroupMode(value: unknown): value is TelegramGroupMode {
  return value === "open" || value === "mention-only";
}

export const telegramAccountConfigAdapter: ChannelAccountConfigAdapter<TelegramChannelAccount> =
  {
    isValidConfig(config) {
      for (const key of Object.keys(config)) {
        if (!TELEGRAM_CONFIG_KEYS.has(key)) {
          return false;
        }
      }
      return (
        (config.token === undefined || isString(config.token)) &&
        (config.group_mode === undefined ||
          isTelegramGroupMode(config.group_mode)) &&
        (config.transcribe_voice === undefined ||
          isBoolean(config.transcribe_voice)) &&
        (config.rich_private_chat_default === undefined ||
          isBoolean(config.rich_private_chat_default)) &&
        (config.rich_draft_streaming === undefined ||
          isBoolean(config.rich_draft_streaming)) &&
        (config.inbound_debounce_ms === undefined ||
          (typeof config.inbound_debounce_ms === "number" &&
            Number.isFinite(config.inbound_debounce_ms) &&
            config.inbound_debounce_ms >= 0 &&
            config.inbound_debounce_ms <= 10000))
      );
    },

    toAccountPatch(config) {
      return {
        token: isNonEmptyString(config.token) ? config.token : undefined,
        groupMode: isTelegramGroupMode(config.group_mode)
          ? config.group_mode
          : undefined,
        transcribeVoice: isBoolean(config.transcribe_voice)
          ? config.transcribe_voice
          : undefined,
        richPrivateChatDefault: isBoolean(config.rich_private_chat_default)
          ? config.rich_private_chat_default
          : undefined,
        richDraftStreaming: isBoolean(config.rich_draft_streaming)
          ? config.rich_draft_streaming
          : undefined,
        inboundDebounceMs:
          typeof config.inbound_debounce_ms === "number" &&
          Number.isFinite(config.inbound_debounce_ms) &&
          config.inbound_debounce_ms >= 0
            ? Math.trunc(Math.min(config.inbound_debounce_ms, 10000))
            : undefined,
      };
    },

    toAccountConfig(account) {
      return {
        has_token: account.token.trim().length > 0,
        group_mode: account.groupMode ?? "open",
        transcribe_voice: account.transcribeVoice === true,
        rich_private_chat_default: account.richPrivateChatDefault !== false,
        rich_draft_streaming: account.richDraftStreaming === true,
        binding: {
          agent_id: account.binding.agentId,
          conversation_id: account.binding.conversationId,
        },
        inbound_debounce_ms: account.inboundDebounceMs,
      };
    },

    toConfigSnapshotConfig(account) {
      return {
        has_token: account.token.trim().length > 0,
        group_mode: account.groupMode ?? "open",
        transcribe_voice: account.transcribeVoice === true,
        rich_private_chat_default: account.richPrivateChatDefault !== false,
        rich_draft_streaming: account.richDraftStreaming === true,
        binding: {
          agent_id: account.binding.agentId,
          conversation_id: account.binding.conversationId,
        },
        inbound_debounce_ms: account.inboundDebounceMs,
      };
    },

    shouldRefreshDisplayName(patch) {
      return patch.token !== undefined && patch.token.trim().length > 0;
    },
  };
