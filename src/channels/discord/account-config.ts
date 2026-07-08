import type { ChannelAccountConfigAdapter } from "@/channels/plugin-types";
import type {
  ChannelDefaultPermissionMode,
  DiscordChannelAccount,
  DiscordChannelMode,
} from "@/channels/types";
import { migratePermissionMode } from "@/permissions/mode";

const DISCORD_CONFIG_KEYS = new Set([
  "token",
  "agent_id",
  "allowed_channels",
  "default_permission_mode",
  "transcribe_voice",
  "auto_thread_on_mention",
  "thread_policy_by_channel",
  "acknowledge_message_reaction",
  "remove_stale_routes",
  "inbound_debounce_ms",
]);

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

function isBoolean(value: unknown): value is boolean {
  return value === true || value === false;
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
        (config.transcribe_voice === undefined ||
          isBoolean(config.transcribe_voice)) &&
        (config.auto_thread_on_mention === undefined ||
          isBoolean(config.auto_thread_on_mention)) &&
        (config.thread_policy_by_channel === undefined ||
          (typeof config.thread_policy_by_channel === "object" &&
            !Array.isArray(config.thread_policy_by_channel) &&
            config.thread_policy_by_channel !== null &&
            Object.values(
              config.thread_policy_by_channel as Record<string, unknown>,
            ).every((v: unknown) => v === true || v === false))) &&
        (config.acknowledge_message_reaction === undefined ||
          isBoolean(config.acknowledge_message_reaction)) &&
        (config.remove_stale_routes === undefined ||
          isBoolean(config.remove_stale_routes)) &&
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
        token: isNonEmptyString(config.token) ? config.token : undefined,
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
        transcribeVoice: isBoolean(config.transcribe_voice)
          ? config.transcribe_voice
          : undefined,
        autoThreadOnMention: isBoolean(config.auto_thread_on_mention)
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
        acknowledgeMessageReaction: isBoolean(
          config.acknowledge_message_reaction,
        )
          ? config.acknowledge_message_reaction
          : undefined,
        removeStaleRoutes: isBoolean(config.remove_stale_routes)
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
        transcribe_voice: account.transcribeVoice === true,
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
        transcribe_voice: account.transcribeVoice === true,
        auto_thread_on_mention: account.autoThreadOnMention ?? false,
        thread_policy_by_channel: account.threadPolicyByChannel ?? {},
        acknowledge_message_reaction:
          account.acknowledgeMessageReaction ?? false,
        remove_stale_routes: account.removeStaleRoutes ?? false,
        inbound_debounce_ms: account.inboundDebounceMs,
      };
    },

    shouldRefreshDisplayName(patch) {
      return patch.token !== undefined && patch.token.trim().length > 0;
    },
  };
