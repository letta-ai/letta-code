import { discordAccountConfigAdapter } from "./discord/accountConfig";
import type {
  ChannelAccountConfigAdapter,
  ChannelAccountPatch,
  ChannelConfigPatch,
  ChannelPluginAccountPatch,
  ChannelProtocolConfig,
} from "./pluginTypes";
import { slackAccountConfigAdapter } from "./slack/accountConfig";
import { telegramAccountConfigAdapter } from "./telegram/accountConfig";
import type { ChannelAccount, SupportedChannelId } from "./types";

const CHANNEL_ACCOUNT_CONFIG_ADAPTERS: Record<
  SupportedChannelId,
  ChannelAccountConfigAdapter<ChannelAccount>
> = {
  telegram:
    telegramAccountConfigAdapter as ChannelAccountConfigAdapter<ChannelAccount>,
  slack:
    slackAccountConfigAdapter as ChannelAccountConfigAdapter<ChannelAccount>,
  discord:
    discordAccountConfigAdapter as ChannelAccountConfigAdapter<ChannelAccount>,
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function getChannelAccountConfigAdapter(
  channelId: SupportedChannelId,
): ChannelAccountConfigAdapter<ChannelAccount> {
  return CHANNEL_ACCOUNT_CONFIG_ADAPTERS[channelId];
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
  channelId: SupportedChannelId,
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
  channelId: SupportedChannelId,
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
  channelId: SupportedChannelId,
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
  channelId: SupportedChannelId,
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
