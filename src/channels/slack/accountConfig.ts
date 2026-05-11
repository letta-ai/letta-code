import type { ChannelAccountConfigAdapter } from "../pluginTypes";
import type { SlackChannelAccount, SlackDefaultPermissionMode } from "../types";

const SLACK_CONFIG_KEYS = new Set([
  "bot_token",
  "app_token",
  "mode",
  "agent_id",
  "default_permission_mode",
]);

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isDefaultPermissionMode(
  value: unknown,
): value is SlackDefaultPermissionMode {
  return (
    value === "standard" ||
    value === "acceptEdits" ||
    value === "unrestricted" ||
    value === "default" || // legacy — migrated to "standard" on read
    value === "bypassPermissions" || // legacy — migrated to "unrestricted" on read
    value === "fullAccess" // legacy — migrated to "unrestricted" on read
  );
}

function migratePermissionMode(
  value:
    | SlackDefaultPermissionMode
    | "default"
    | "bypassPermissions"
    | "fullAccess",
): SlackDefaultPermissionMode {
  if (value === "default") return "standard";
  if (value === "bypassPermissions" || value === "fullAccess")
    return "unrestricted";
  return value;
}

export const slackAccountConfigAdapter: ChannelAccountConfigAdapter<SlackChannelAccount> =
  {
    isValidConfig(config) {
      for (const key of Object.keys(config)) {
        if (!SLACK_CONFIG_KEYS.has(key)) {
          return false;
        }
      }
      return (
        (config.bot_token === undefined || isString(config.bot_token)) &&
        (config.app_token === undefined || isString(config.app_token)) &&
        (config.mode === undefined || config.mode === "socket") &&
        (config.agent_id === undefined || isNullableString(config.agent_id)) &&
        (config.default_permission_mode === undefined ||
          isDefaultPermissionMode(config.default_permission_mode))
      );
    },

    toAccountPatch(config) {
      return {
        botToken: isString(config.bot_token) ? config.bot_token : undefined,
        appToken: isString(config.app_token) ? config.app_token : undefined,
        mode: config.mode === "socket" ? "socket" : undefined,
        agentId: isNullableString(config.agent_id)
          ? config.agent_id
          : undefined,
        defaultPermissionMode: isDefaultPermissionMode(
          config.default_permission_mode,
        )
          ? migratePermissionMode(config.default_permission_mode)
          : undefined,
      };
    },

    toAccountConfig(account) {
      return {
        mode: account.mode,
        has_bot_token: account.botToken.trim().length > 0,
        has_app_token: account.appToken.trim().length > 0,
        agent_id: account.agentId,
        default_permission_mode: account.defaultPermissionMode ?? "standard",
      };
    },

    toConfigSnapshotConfig(account) {
      return {
        mode: account.mode,
        has_bot_token: account.botToken.trim().length > 0,
        has_app_token: account.appToken.trim().length > 0,
        agent_id: account.agentId,
        default_permission_mode: account.defaultPermissionMode ?? "standard",
      };
    },

    shouldRefreshDisplayName(patch) {
      return patch.botToken !== undefined || patch.appToken !== undefined;
    },
  };
