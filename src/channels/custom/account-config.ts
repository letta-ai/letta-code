import type { ChannelAccountConfigAdapter } from "@/channels/plugin-types";
import type { CustomChannelAccount } from "@/channels/types";

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
      void config;
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
      return false;
    },
  };
