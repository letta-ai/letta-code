import type { ChannelAccountConfigAdapter } from "../pluginTypes";
import type { DiscordChannelAccount } from "../types";

const DISCORD_CONFIG_KEYS = new Set(["token", "agent_id", "allowed_channels"]);

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
          isStringArray(config.allowed_channels))
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
      };
    },

    toAccountConfig(account) {
      return {
        has_token: account.token.trim().length > 0,
        agent_id: account.agentId,
        allowed_channels: [...(account.allowedChannels ?? [])],
      };
    },

    toConfigSnapshotConfig(account) {
      return {
        has_token: account.token.trim().length > 0,
        agent_id: account.agentId,
        allowed_channels: [...(account.allowedChannels ?? [])],
      };
    },

    shouldRefreshDisplayName(patch) {
      return patch.token !== undefined;
    },
  };
