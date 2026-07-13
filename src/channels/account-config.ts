import { isRecord } from "@/utils/type-guards";
import {
  configSecretFieldPathToKey,
  getConfigSecretKeys,
  getPersistedSecretRefPaths,
  isPresentSecretValue,
} from "./credential-utils";
import { customAccountConfigAdapter } from "./custom/account-config";
import { discordAccountConfigAdapter } from "./discord/account-config";
import { getChannelPluginMetadata } from "./plugin-registry";
import type {
  ChannelAccountConfigAdapter,
  ChannelAccountPatch,
  ChannelConfigPatch,
  ChannelPluginAccountPatch,
  ChannelProtocolConfig,
} from "./plugin-types";
import { redactConfigForSnapshot } from "./schema-config";
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

function getSchemaForAccount(account: ChannelAccount) {
  try {
    return getChannelPluginMetadata(account.channel).configSchema;
  } catch {
    return undefined;
  }
}

function getConfigRefSecretKeys(account: ChannelAccount): Set<string> {
  const keys = new Set<string>();
  for (const fieldPath of getPersistedSecretRefPaths(account)) {
    const key = configSecretFieldPathToKey(fieldPath);
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

function isCustomConfigConfigured(account: ChannelAccount): boolean {
  if (!isCustomChannelAccount(account)) {
    return false;
  }
  return (
    Object.keys(account.config).length > 0 ||
    getConfigRefSecretKeys(account).size > 0
  );
}

/**
 * Build a client-safe snapshot of a user-plugin account config when no
 * schema is available. Surfaces every non-secret value from the stored
 * config (so fields like `accounts_json` / `configs_json` / `agent_id`
 * round-trip to the UI) while collapsing recognized secret keys to
 * `has_<key>` booleans (Slack pattern). Persisted refs are treated as
 * secrets even if plugin metadata is missing.
 */
function redactSchemalessConfig(
  account: ChannelAccount,
  storedConfig: Record<string, unknown>,
): ChannelProtocolConfig {
  const result: ChannelProtocolConfig = {};
  const persistedRefKeys = getConfigRefSecretKeys(account);
  const secretKeys = getConfigSecretKeys(
    account.channel,
    getPersistedSecretRefPaths(account),
  );
  for (const [key, value] of Object.entries(storedConfig)) {
    if (secretKeys.has(key)) {
      result[`has_${key}`] = isPresentSecretValue(value);
      continue;
    }
    result[key] = value;
  }
  for (const key of persistedRefKeys) {
    result[`has_${key}`] = true;
  }
  return result;
}

function redactCustomConfig(account: ChannelAccount): ChannelProtocolConfig {
  if (!isCustomChannelAccount(account)) {
    return {};
  }
  const schema = getSchemaForAccount(account);
  if (!schema) {
    return redactSchemalessConfig(account, account.config);
  }

  const result = redactConfigForSnapshot(schema, account.config);
  for (const key of getConfigRefSecretKeys(account)) {
    result[`has_${key}`] = true;
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
        ...redactCustomConfig(account),
        configured: isCustomConfigConfigured(account),
      };
    },
    toConfigSnapshotConfig(account) {
      if (!isCustomChannelAccount(account)) {
        return {};
      }
      return {
        ...redactCustomConfig(account),
        configured: isCustomConfigConfigured(account),
      };
    },
    shouldRefreshDisplayName() {
      return false;
    },
  };

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
