import { customAccountConfigAdapter } from "./custom/accountConfig";
import { discordAccountConfigAdapter } from "./discord/accountConfig";
import type {
  ChannelAccountConfigAdapter,
  ChannelAccountPatch,
  ChannelConfigPatch,
  ChannelConfigSchema,
  ChannelPluginAccountPatch,
  ChannelProtocolConfig,
} from "./pluginTypes";
import {
  redactConfigForSnapshot,
  validateConfigAgainstSchema,
} from "./schemaConfig";
import { slackAccountConfigAdapter } from "./slack/accountConfig";
import { telegramAccountConfigAdapter } from "./telegram/accountConfig";
import type { ChannelAccount } from "./types";
import { isCustomChannelAccount, isFirstPartyChannelId } from "./types";

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
};

/**
 * Reserved custom-channel keys that are safe to surface to the desktop UI
 * verbatim. Plugins without a declared schema route through this allow-list
 * — any non-reserved keys in the stored config are dropped to avoid
 * leaking plugin-specific secrets (api_key, password, token, etc.) that
 * we don't recognize.
 */
const CUSTOM_SAFE_KEYS = new Set([
  "url",
  "agent_id",
  "accounts_json",
  "configs_json",
  "metadata_json",
]);

/**
 * Known secret keys for the custom channel. Stored values are never sent
 * back to the client; only their `has_<key>` presence flag is exposed.
 */
const CUSTOM_SECRET_KEYS = new Set(["bot_token", "auth"]);

/**
 * Build a client-safe snapshot of a schemaless user-plugin account
 * config. Only emits:
 *   - reserved custom-channel keys (url / agent_id / *_json) as-is
 *   - has_<key> presence booleans for known secret keys
 * Any other stored keys are dropped, since we can't tell whether they
 * contain sensitive data and the schemaless dialog doesn't surface them.
 */
function redactSchemalessConfig(
  storedConfig: Record<string, unknown>,
): ChannelProtocolConfig {
  const result: ChannelProtocolConfig = {};
  for (const key of CUSTOM_SAFE_KEYS) {
    if (key in storedConfig) {
      result[key] = storedConfig[key];
    }
  }
  for (const key of CUSTOM_SECRET_KEYS) {
    const value = storedConfig[key];
    result[`has_${key}`] = typeof value === "string" && value.trim().length > 0;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Build a {@link ChannelAccountConfigAdapter} from a declared
 * {@link ChannelConfigSchema}. Used as a fallback for user-installed plugins
 * that don't ship a hand-written adapter.
 */
function _buildSchemaAdapter(
  schema: ChannelConfigSchema,
): ChannelAccountConfigAdapter<ChannelAccount> {
  return {
    isValidConfig(config) {
      return validateConfigAgainstSchema(schema, config).ok;
    },
    toAccountPatch() {
      return {};
    },
    toAccountConfig(account) {
      const config = isCustomChannelAccount(account) ? account.config : {};
      return redactConfigForSnapshot(schema, config);
    },
    toConfigSnapshotConfig(account) {
      const config = isCustomChannelAccount(account) ? account.config : {};
      return redactConfigForSnapshot(schema, config);
    },
    shouldRefreshDisplayName() {
      return false;
    },
  };
}

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
  //
  // Schema-driven adapter retained for future use:
  //   const metadata = getChannelPluginMetadata(channelId);
  //   if (metadata.configSchema) return buildSchemaAdapter(metadata.configSchema);
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
