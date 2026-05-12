import type { ChannelAccountConfigAdapter } from "../pluginTypes";
import type { CustomChannelAccount } from "../types";

/**
 * Account config adapter for the first-party "custom" channel.
 *
 * The "custom" channel forwards outbound agent messages to a user-configured
 * webhook URL. Each account stores:
 *   url            — webhook endpoint that receives outbound messages
 *   bot_token      — sent as `Authorization: Bearer <bot_token>` (write-only)
 *   auth           — sent as `X-Letta-Auth: <auth>` (write-only)
 *   agent_id       — agent this app is bound to
 *   accounts_json  — user-supplied JSON describing accounts on the remote service
 *   configs_json   — user-supplied JSON of arbitrary configuration values
 *   metadata_json  — user-supplied JSON of additional plugin configuration
 *                    (anything that doesn't fit accounts_json / configs_json);
 *                    plugins are free to read and interpret this however they want
 *
 * Tokens never round-trip back to the client; snapshots only expose
 * `has_bot_token` / `has_auth` boolean flags.
 */
const CUSTOM_CONFIG_KEYS = new Set([
  "url",
  "bot_token",
  "auth",
  "agent_id",
  "accounts_json",
  "configs_json",
  "metadata_json",
]);

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function readString(account: CustomChannelAccount, key: string): string {
  const value = account.config[key];
  return typeof value === "string" ? value : "";
}

function readNullableString(
  account: CustomChannelAccount,
  key: string,
): string | null {
  const value = account.config[key];
  return value === null || typeof value === "string" ? value : null;
}

export const customAccountConfigAdapter: ChannelAccountConfigAdapter<CustomChannelAccount> =
  {
    isValidConfig(config) {
      for (const key of Object.keys(config)) {
        if (!CUSTOM_CONFIG_KEYS.has(key)) {
          return false;
        }
      }
      return (
        (config.url === undefined || isString(config.url)) &&
        (config.bot_token === undefined || isString(config.bot_token)) &&
        (config.auth === undefined || isString(config.auth)) &&
        (config.agent_id === undefined || isNullableString(config.agent_id)) &&
        (config.accounts_json === undefined ||
          isString(config.accounts_json)) &&
        (config.configs_json === undefined || isString(config.configs_json)) &&
        (config.metadata_json === undefined || isString(config.metadata_json))
      );
    },

    toAccountPatch(config) {
      // The "custom" channel doesn't use ChannelPluginAccountPatch fields;
      // everything is preserved on the generic `config` bag via mergeAccountPatch.
      // Returning {} signals "no specific field changes" — the caller already
      // applies `patch.config` directly to `account.config`.
      const _ = config;
      return {};
    },

    toAccountConfig(account) {
      return {
        url: readString(account, "url"),
        has_bot_token: readString(account, "bot_token").trim().length > 0,
        has_auth: readString(account, "auth").trim().length > 0,
        agent_id: readNullableString(account, "agent_id"),
        accounts_json: readString(account, "accounts_json"),
        configs_json: readString(account, "configs_json"),
        metadata_json: readString(account, "metadata_json"),
      };
    },

    toConfigSnapshotConfig(account) {
      return this.toAccountConfig(account);
    },

    shouldRefreshDisplayName() {
      // Display name is user-supplied (no token-based auto-derivation), so
      // we never need to refresh it from a config patch.
      return false;
    },
  };
