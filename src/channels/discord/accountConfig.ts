import type { ChannelAccountConfigAdapter } from "../pluginTypes";
import type { DiscordChannelAccount, DiscordChannelPolicy } from "../types";

const DISCORD_CONFIG_KEYS = new Set([
  "token",
  "agent_id",
  "allowed_channels",
  "transcribe_voice",
  "channel_policy",
  "auto_thread_on_mention",
]);

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isDiscordChannelPolicy(value: unknown): value is DiscordChannelPolicy {
  return value === "mention" || value === "open";
}

export const discordAccountConfigAdapter: ChannelAccountConfigAdapter<DiscordChannelAccount> =
  {
    isValidConfig(config) {
      for (const key of Object.keys(config)) {
        if (!DISCORD_CONFIG_KEYS.has(key)) {
          return false;
        }
      }
      return (
        (config.token === undefined || isString(config.token)) &&
        (config.agent_id === undefined || isNullableString(config.agent_id)) &&
        (config.allowed_channels === undefined ||
          isStringArray(config.allowed_channels)) &&
        (config.transcribe_voice === undefined ||
          isBoolean(config.transcribe_voice)) &&
        (config.channel_policy === undefined ||
          isDiscordChannelPolicy(config.channel_policy)) &&
        (config.auto_thread_on_mention === undefined ||
          isBoolean(config.auto_thread_on_mention))
      );
    },

    toAccountPatch(config) {
      return {
        token: isString(config.token) ? config.token : undefined,
        agentId: isNullableString(config.agent_id)
          ? config.agent_id
          : undefined,
        allowedChannels: isStringArray(config.allowed_channels)
          ? [...config.allowed_channels]
          : undefined,
        transcribeVoice: isBoolean(config.transcribe_voice)
          ? config.transcribe_voice
          : undefined,
        channelPolicy: isDiscordChannelPolicy(config.channel_policy)
          ? config.channel_policy
          : undefined,
        autoThreadOnMention: isBoolean(config.auto_thread_on_mention)
          ? config.auto_thread_on_mention
          : undefined,
      };
    },

    toAccountConfig(account) {
      return {
        has_token: account.token.trim().length > 0,
        agent_id: account.agentId,
        allowed_channels: [...(account.allowedChannels ?? [])],
        transcribe_voice: account.transcribeVoice === true,
        channel_policy: account.channelPolicy ?? "mention",
        auto_thread_on_mention: account.autoThreadOnMention ?? true,
      };
    },

    toConfigSnapshotConfig(account) {
      return {
        has_token: account.token.trim().length > 0,
        agent_id: account.agentId,
        allowed_channels: [...(account.allowedChannels ?? [])],
        transcribe_voice: account.transcribeVoice === true,
        channel_policy: account.channelPolicy ?? "mention",
        auto_thread_on_mention: account.autoThreadOnMention ?? true,
      };
    },

    shouldRefreshDisplayName(patch) {
      return patch.token !== undefined;
    },
  };
