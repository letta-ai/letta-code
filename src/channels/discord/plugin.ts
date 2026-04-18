import type { ChannelPlugin } from "../pluginTypes";
import type { ChannelAccount, DiscordChannelAccount } from "../types";
import { createDiscordAdapter } from "./adapter";
import { discordMessageActions } from "./messageActions";
import { runDiscordSetup } from "./setup";

export const discordChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "discord",
    displayName: "Discord",
    runtimePackages: ["discord.js@14.18.0"],
    runtimeModules: ["discord.js"],
  },
  createAdapter(account: ChannelAccount) {
    return createDiscordAdapter(account as DiscordChannelAccount);
  },
  messageActions: discordMessageActions,
  runSetup() {
    return runDiscordSetup();
  },
};
