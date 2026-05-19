import { migratePermissionMode } from "../../permissions/mode";
import type { ChannelAccountConfigAdapter } from "../pluginTypes";
import type {
  ChannelDefaultPermissionMode,
  DiscordChannelAccount,
  DiscordChannelMode,
} from "../types";

const DISCORD_CONFIG_KEYS = new Set([
  "token",
  "agent_id",
  "allowed_channels",
  "default_permission_mode",
  "auto_thread_on_mention",
  "thread_policy_by_channel",
  "acknowledge_message_reaction",
  "remove_stale_routes",
  "inbound_debounce_ms",
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

function isDiscordChannelMode(value: unknown): value is DiscordChannelMode {
  return value === "open" || value === "mention-only";
}

/**
 * Validate a mode map: must be a flat record of channelId → "open"|"mention-only".
 */
function isModeMap(
  value: unknown,
): value is Record<string, DiscordChannelMode> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.values(record).every(isDiscordChannelMode);
}

/**
 * Accept both legacy `string[]` and new `Record<string, DiscordChannelMode>`.
 */
function isAllowedChannels(
  value: unknown,
): value is string[] | Record<string, DiscordChannelMode> {
  return isStringArray(value) || isModeMap(value);
}

function isDefaultPermissionMode(
  value: unknown,
): value is ChannelDefaultPermissionMode {
  return (
    value === "standard" ||
    value === "acceptEdits" ||
    value === "unrestricted" ||
    value === "default" || // legacy → "standard"
    value === "bypassPermissions" || // legacy → "unrestricted"
    value === "fullAccess" // legacy → "unrestricted"
  );
}

/**
 * Serialize allowedChannels back to protocol form.
 * Preserves the original shape: arrays stay arrays, maps stay maps.
 */
function serializeAllowedChannels(
  allowedChannels: DiscordChannelAccount["allowedChannels"],
): string[] | Record<string, DiscordChannelMode> {
  if (!allowedChannels) {
    return [];
  }
  if (Array.isArray(allowedChannels)) {
    return [...allowedChannels];
  }
  return { ...allowedChannels };
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
          isAllowedChannels(config.allowed_channels)) &&
        (config.default_permission_mode === undefined ||
          isDefaultPermissionMode(config.default_permission_mode)) &&
        (config.auto_thread_on_mention === undefined ||
          config.auto_thread_on_mention === true ||
          config.auto_thread_on_mention === false) &&
        (config.thread_policy_by_channel === undefined ||
          (typeof config.thread_policy_by_channel === "object" &&
            !Array.isArray(config.thread_policy_by_channel) &&
            config.thread_policy_by_channel !== null &&
            Object.values(
              config.thread_policy_by_channel as Record<string, unknown>,
            ).every((v: unknown) => v === true || v === false))) &&
        (config.acknowledge_message_reaction === undefined ||
          config.acknowledge_message_reaction === true ||
          config.acknowledge_message_reaction === false) &&
        (config.remove_stale_routes === undefined ||
          config.remove_stale_routes === true ||
          config.remove_stale_routes === false) &&
        (config.inbound_debounce_ms === undefined ||
          (typeof config.inbound_debounce_ms === "number" &&
            Number.isFinite(config.inbound_debounce_ms) &&
            config.inbound_debounce_ms >= 0 &&
            config.inbound_debounce_ms <= 10000))
      );
    },

    toAccountPatch(config) {
      const allowedChannels = isAllowedChannels(config.allowed_channels)
        ? Array.isArray(config.allowed_channels)
          ? [...config.allowed_channels]
          : { ...config.allowed_channels }
        : undefined;

      return {
        token: isString(config.token) ? config.token : undefined,
        agentId: isNullableString(config.agent_id)
          ? config.agent_id
          : undefined,
        defaultPermissionMode: isDefaultPermissionMode(
          config.default_permission_mode,
        )
          ? (migratePermissionMode(
              config.default_permission_mode,
            ) as ChannelDefaultPermissionMode)
          : undefined,
        allowedChannels,
        autoThreadOnMention:
          config.auto_thread_on_mention === true ||
          config.auto_thread_on_mention === false
            ? config.auto_thread_on_mention
            : undefined,
        threadPolicyByChannel:
          typeof config.thread_policy_by_channel === "object" &&
          !Array.isArray(config.thread_policy_by_channel)
            ? { ...config.thread_policy_by_channel }
            : undefined,
        inboundDebounceMs:
          typeof config.inbound_debounce_ms === "number" &&
          Number.isFinite(config.inbound_debounce_ms) &&
          config.inbound_debounce_ms >= 0
            ? Math.trunc(Math.min(config.inbound_debounce_ms, 10000))
            : undefined,
        acknowledgeMessageReaction:
          config.acknowledge_message_reaction === true ||
          config.acknowledge_message_reaction === false
            ? config.acknowledge_message_reaction
            : undefined,
        removeStaleRoutes:
          config.remove_stale_routes === true ||
          config.remove_stale_routes === false
            ? config.remove_stale_routes
            : undefined,
      };
    },

    toAccountConfig(account) {
      return {
        has_token: account.token.trim().length > 0,
        agent_id: account.agentId,
        default_permission_mode: account.defaultPermissionMode ?? "standard",
        allowed_channels: serializeAllowedChannels(account.allowedChannels),
        auto_thread_on_mention: account.autoThreadOnMention ?? false,
        thread_policy_by_channel: account.threadPolicyByChannel ?? {},
        acknowledge_message_reaction:
          account.acknowledgeMessageReaction ?? false,
        remove_stale_routes: account.removeStaleRoutes ?? false,
        inbound_debounce_ms: account.inboundDebounceMs,
      };
    },

    toConfigSnapshotConfig(account) {
      return {
        has_token: account.token.trim().length > 0,
        agent_id: account.agentId,
        default_permission_mode: account.defaultPermissionMode ?? "standard",
        allowed_channels: serializeAllowedChannels(account.allowedChannels),
        auto_thread_on_mention: account.autoThreadOnMention ?? false,
        thread_policy_by_channel: account.threadPolicyByChannel ?? {},
        acknowledge_message_reaction:
          account.acknowledgeMessageReaction ?? false,
        remove_stale_routes: account.removeStaleRoutes ?? false,
        inbound_debounce_ms: account.inboundDebounceMs,
      };
    },

    shouldRefreshDisplayName(patch) {
      return patch.token !== undefined;
    },
  };
