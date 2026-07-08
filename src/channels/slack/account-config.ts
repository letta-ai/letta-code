import { isNonEmptyString } from "@/channels/credential-utils";
import type { ChannelAccountConfigAdapter } from "@/channels/plugin-types";
import {
  DEFAULT_SLACK_PERMISSION_MODE,
  type SlackChannelAccount,
  type SlackDefaultPermissionMode,
} from "@/channels/types";
import { migratePermissionMode } from "@/permissions/mode";

const SLACK_CONFIG_KEYS = new Set([
  "bot_token",
  "app_token",
  "mode",
  "agent_id",
  "default_permission_mode",
  "transcribe_voice",
  "show_completed_reaction",
  "listen_mode",
]);

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return value === true || value === false;
}

function isDefaultPermissionMode(
  value: unknown,
): value is SlackDefaultPermissionMode {
  // Also accepts legacy values that migratePermissionMode will map to current names.
  return (
    value === "standard" ||
    value === "acceptEdits" ||
    value === "unrestricted" ||
    value === "default" || // legacy → "standard"
    value === "bypassPermissions" || // legacy → "unrestricted"
    value === "fullAccess" // legacy → "unrestricted"
  );
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
          isDefaultPermissionMode(config.default_permission_mode)) &&
        (config.transcribe_voice === undefined ||
          isBoolean(config.transcribe_voice)) &&
        (config.show_completed_reaction === undefined ||
          isBoolean(config.show_completed_reaction)) &&
        (config.listen_mode === undefined || isBoolean(config.listen_mode))
      );
    },

    toAccountPatch(config) {
      return {
        botToken: isNonEmptyString(config.bot_token)
          ? config.bot_token
          : undefined,
        appToken: isNonEmptyString(config.app_token)
          ? config.app_token
          : undefined,
        mode: config.mode === "socket" ? "socket" : undefined,
        agentId: isNullableString(config.agent_id)
          ? config.agent_id
          : undefined,
        defaultPermissionMode: isDefaultPermissionMode(
          config.default_permission_mode,
        )
          ? (migratePermissionMode(
              config.default_permission_mode,
            ) as SlackDefaultPermissionMode)
          : undefined,
        transcribeVoice: isBoolean(config.transcribe_voice)
          ? config.transcribe_voice
          : undefined,
        listenMode: isBoolean(config.listen_mode)
          ? config.listen_mode
          : undefined,
      };
    },

    toAccountConfig(account) {
      return {
        mode: account.mode,
        has_bot_token: account.botToken.trim().length > 0,
        has_app_token: account.appToken.trim().length > 0,
        agent_id: account.agentId,
        default_permission_mode:
          account.defaultPermissionMode ?? DEFAULT_SLACK_PERMISSION_MODE,
        transcribe_voice: account.transcribeVoice === true,
        listen_mode: account.listenMode === true,
      };
    },

    toConfigSnapshotConfig(account) {
      return {
        mode: account.mode,
        has_bot_token: account.botToken.trim().length > 0,
        has_app_token: account.appToken.trim().length > 0,
        agent_id: account.agentId,
        default_permission_mode:
          account.defaultPermissionMode ?? DEFAULT_SLACK_PERMISSION_MODE,
        transcribe_voice: account.transcribeVoice === true,
        listen_mode: account.listenMode === true,
      };
    },

    shouldRefreshDisplayName(patch) {
      return (
        (patch.botToken !== undefined && patch.botToken.trim().length > 0) ||
        (patch.appToken !== undefined && patch.appToken.trim().length > 0)
      );
    },
  };
