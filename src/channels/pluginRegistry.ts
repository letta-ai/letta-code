import type { ChannelPlugin, ChannelPluginMetadata } from "./pluginTypes";
import type { SupportedChannelId } from "./types";
import { SUPPORTED_CHANNEL_IDS } from "./types";

type ChannelPluginRegistration = {
  metadata: ChannelPluginMetadata;
  load: () => Promise<ChannelPlugin>;
};

const CHANNEL_PLUGIN_REGISTRATIONS: Record<
  SupportedChannelId,
  ChannelPluginRegistration
> = {
  telegram: {
    metadata: {
      id: "telegram",
      displayName: "Telegram",
      runtimePackages: ["grammy@1.42.0"],
      runtimeModules: ["grammy"],
    },
    load: async () => {
      const { telegramChannelPlugin } = await import("./telegram/plugin");
      return telegramChannelPlugin;
    },
  },
  slack: {
    metadata: {
      id: "slack",
      displayName: "Slack",
      runtimePackages: ["@slack/bolt@4.7.0", "@slack/web-api@7.15.0"],
      runtimeModules: ["@slack/bolt", "@slack/web-api"],
    },
    load: async () => {
      const { slackChannelPlugin } = await import("./slack/plugin");
      return slackChannelPlugin;
    },
  },
};

export function isSupportedChannelId(
  value: string,
): value is SupportedChannelId {
  return SUPPORTED_CHANNEL_IDS.includes(value as SupportedChannelId);
}

export function getSupportedChannelIds(): SupportedChannelId[] {
  return [...SUPPORTED_CHANNEL_IDS];
}

export function getChannelPluginMetadata(
  channelId: SupportedChannelId,
): ChannelPluginMetadata {
  return CHANNEL_PLUGIN_REGISTRATIONS[channelId].metadata;
}

export function getChannelDisplayName(channelId: SupportedChannelId): string {
  return getChannelPluginMetadata(channelId).displayName;
}

export async function loadChannelPlugin(
  channelId: SupportedChannelId,
): Promise<ChannelPlugin> {
  return CHANNEL_PLUGIN_REGISTRATIONS[channelId].load();
}
