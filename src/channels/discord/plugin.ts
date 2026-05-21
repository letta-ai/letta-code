import type { ChannelPlugin } from "@/channels/plugin-types";
import type { ChannelAccount, DiscordChannelAccount } from "@/channels/types";
import { createDiscordAdapter } from "./adapter";
import { discordMessageActions } from "./message-actions";
import { runDiscordSetup } from "./setup";

export const discordChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "discord",
    displayName: "Discord",
    runtimePackages: ["discord.js@14.18.0"],
    runtimeModules: ["discord.js"],
    source: "first-party",
    firstParty: true,
  },
  createAdapter(account: ChannelAccount) {
    return createDiscordAdapter(account as DiscordChannelAccount);
  },
  messageActions: discordMessageActions,
  runSetup() {
    return runDiscordSetup();
  },
};
