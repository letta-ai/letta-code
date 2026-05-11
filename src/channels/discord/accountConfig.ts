import type { ChannelAccountConfigAdapter } from "../pluginTypes";
import type {
  ChannelDefaultPermissionMode,
  DiscordChannelAccount,
} from "../types";

const DISCORD_CONFIG_KEYS = new Set([
  "token",
  "agent_id",
  "allowed_channels",
  "default_permission_mode",
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

function isDefaultPermissionMode(
  value: unknown,
): value is ChannelDefaultPermissionMode {
  return (
    value === "default" ||
    value === "acceptEdits" ||
    value === "bypassPermissions"
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
          isStringArray(config.allowed_channels)) &&
        (config.default_permission_mode === undefined ||
          isDefaultPermissionMode(config.default_permission_mode))
      );
    },

    toAccountPatch(config) {
      return {
        token: isString(config.token) ? config.token : undefined,
        agentId: isNullableString(config.agent_id)
          ? config.agent_id
          : undefined,
        defaultPermissionMode: isDefaultPermissionMode(
          config.default_permission_mode,
        )
          ? config.default_permission_mode
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
        default_permission_mode: account.defaultPermissionMode ?? "default",
        allowed_channels: [...(account.allowedChannels ?? [])],
      };
    },

    toConfigSnapshotConfig(account) {
      return {
        has_token: account.token.trim().length > 0,
        agent_id: account.agentId,
        default_permission_mode: account.defaultPermissionMode ?? "default",
        allowed_channels: [...(account.allowedChannels ?? [])],
      };
    },

    shouldRefreshDisplayName(patch) {
      return patch.token !== undefined;
    },
  };
