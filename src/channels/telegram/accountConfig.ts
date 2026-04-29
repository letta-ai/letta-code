import type { ChannelAccountConfigAdapter } from "../pluginTypes";
import type { TelegramChannelAccount } from "../types";

const TELEGRAM_CONFIG_KEYS = new Set(["token", "transcribe_voice"]);

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
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
        (config.transcribe_voice === undefined ||
          isBoolean(config.transcribe_voice))
      );
    },

    toAccountPatch(config) {
      return {
        token: isString(config.token) ? config.token : undefined,
        transcribeVoice: isBoolean(config.transcribe_voice)
          ? config.transcribe_voice
          : undefined,
      };
    },

    toAccountConfig(account) {
      return {
        has_token: account.token.trim().length > 0,
        transcribe_voice: account.transcribeVoice === true,
        binding: {
          agent_id: account.binding.agentId,
          conversation_id: account.binding.conversationId,
        },
      };
    },

    toConfigSnapshotConfig(account) {
      return {
        has_token: account.token.trim().length > 0,
        transcribe_voice: account.transcribeVoice === true,
        binding: {
          agent_id: account.binding.agentId,
          conversation_id: account.binding.conversationId,
        },
      };
    },

    shouldRefreshDisplayName(patch) {
      return patch.token !== undefined;
    },
  };
