import { customAccountConfigAdapter } from "./custom/account-config";
import { discordAccountConfigAdapter } from "./discord/account-config";
import type {
  ChannelAccountConfigAdapter,
  ChannelAccountPatch,
  ChannelConfigPatch,
  ChannelPluginAccountPatch,
  ChannelProtocolConfig,
} from "./plugin-types";
import { signalAccountConfigAdapter } from "./signal/account-config";
import { slackAccountConfigAdapter } from "./slack/account-config";
import { telegramAccountConfigAdapter } from "./telegram/account-config";
import type { ChannelAccount } from "./types";
import { isCustomChannelAccount, isFirstPartyChannelId } from "./types";
import { whatsappAccountConfigAdapter } from "./whatsapp/account-config";

const CHANNEL_ACCOUNT_CONFIG_ADAPTERS: Record<
  string,
  ChannelAccountConfigAdapter<ChannelAccount>
> = {
  telegram:
    telegramAccountConfigAdapter as ChannelAccountConfigAdapter<ChannelAccount>,
  slack:
    slackAccountConfigAdapter as ChannelAccountConfigAdapter<ChannelAccount>,
  discord:
    discordAccountConfigAdapter as ChannelAccountConfigAdapter<ChannelAccount>,
  custom:
    customAccountConfigAdapter as ChannelAccountConfigAdapter<ChannelAccount>,
  whatsapp:
    whatsappAccountConfigAdapter as ChannelAccountConfigAdapter<ChannelAccount>,
  signal:
    signalAccountConfigAdapter as ChannelAccountConfigAdapter<ChannelAccount>,
};

/**
 * Keys recognized as secrets across all user-installed plugins. These are
 * never sent back to the client; only their `has_<key>` presence flag is
 * exposed. Keep in sync with the secret-handling convention in
 * `customAccountConfigAdapter` (which uses `bot_token` / `auth`).
 */
const KNOWN_SECRET_KEYS = new Set(["bot_token", "auth"]);

/**
 * Build a client-safe snapshot of a user-plugin account config when no
 * schema is available. Surfaces every non-secret value from the stored
 * config (so fields like `accounts_json` / `configs_json` / `agent_id`
 * round-trip to the UI) while collapsing recognized secret keys to
 * `has_<key>` booleans (Slack pattern).
 */
function redactSchemalessConfig(
  storedConfig: Record<string, unknown>,
): ChannelProtocolConfig {
  const result: ChannelProtocolConfig = {};
  for (const [key, value] of Object.entries(storedConfig)) {
    if (KNOWN_SECRET_KEYS.has(key)) {
      result[`has_${key}`] =
        typeof value === "string" && value.trim().length > 0;
      continue;
    }
    result[key] = value;
  }
  return result;
}

const customChannelAccountConfigAdapter: ChannelAccountConfigAdapter<ChannelAccount> =
  {
    isValidConfig() {
      return true;
    },
    toAccountPatch() {
      return {};
    },
    toAccountConfig(account) {
      if (!isCustomChannelAccount(account)) {
        return {};
      }
      return {
        ...redactSchemalessConfig(account.config),
        configured: Object.keys(account.config).length > 0,
      };
    },
    toConfigSnapshotConfig(account) {
      if (!isCustomChannelAccount(account)) {
        return {};
      }
      return {
        ...redactSchemalessConfig(account.config),
        configured: Object.keys(account.config).length > 0,
      };
    },
    shouldRefreshDisplayName() {
      return false;
    },
  };

import { isRecord } from "@/utils/type-guards";
export { isRecord };

export function getChannelAccountConfigAdapter(
  channelId: string,
): ChannelAccountConfigAdapter<ChannelAccount> {
  if (isFirstPartyChannelId(channelId)) {
    return (
      CHANNEL_ACCOUNT_CONFIG_ADAPTERS[channelId] ??
      customChannelAccountConfigAdapter
    );
  }
  // MVP: user-installed plugins (e.g. bluesky, my-webhook-app) all share
  // the 'custom' channel's account-config shape and are managed through
  // the same desktop dialog. Per-plugin schema-driven adapters are wired
  // but not yet routed here — the dialog always sends the custom shape,
  // so validating against a plugin-specific schema would reject the
  // save (timeouts) until the dialog opts a plugin in.

  return customChannelAccountConfigAdapter;
}

export function getChannelPluginConfig(
  input: Record<string, unknown>,
  key: "config" | "plugin_config" = "config",
): ChannelProtocolConfig | null {
  const value = input[key];
  if (value === undefined) {
    return {};
  }
  return isRecord(value) ? value : null;
}

export function isValidChannelPluginConfigPayload(
  channelId: string,
  input: Record<string, unknown>,
  key: "config" | "plugin_config" = "config",
): boolean {
  const config = getChannelPluginConfig(input, key);
  if (!config) {
    return false;
  }
  return getChannelAccountConfigAdapter(channelId).isValidConfig(config);
}

export function normalizeChannelAccountPatch(
  channelId: string,
  patch: ChannelAccountPatch,
): ChannelAccountPatch {
  const pluginPatch = patch.config
    ? getChannelAccountConfigAdapter(channelId).toAccountPatch(patch.config)
    : {};
  return {
    ...patch,
    ...pluginPatch,
  };
}

export function normalizeChannelConfigPatch(
  channelId: string,
  patch: ChannelConfigPatch,
): ChannelConfigPatch {
  const pluginPatch = patch.config
    ? getChannelAccountConfigAdapter(channelId).toAccountPatch(patch.config)
    : {};
  return {
    ...patch,
    ...pluginPatch,
  };
}

export function channelPluginConfigShouldRefreshDisplayName(
  channelId: string,
  patch: Pick<ChannelAccountPatch, keyof ChannelPluginAccountPatch | "config">,
): boolean {
  const adapter = getChannelAccountConfigAdapter(channelId);
  const pluginPatch = patch.config
    ? adapter.toAccountPatch(patch.config)
    : patch;
  return adapter.shouldRefreshDisplayName(pluginPatch);
}

export function toChannelAccountProtocolConfig(
  account: ChannelAccount,
): ChannelProtocolConfig {
  return getChannelAccountConfigAdapter(account.channel).toAccountConfig(
    account,
  );
}

export function toChannelConfigSnapshotProtocolConfig(
  account: ChannelAccount,
): ChannelProtocolConfig {
  return getChannelAccountConfigAdapter(account.channel).toConfigSnapshotConfig(
    account,
  );
}
