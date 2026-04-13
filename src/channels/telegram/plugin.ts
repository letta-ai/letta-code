import type { ChannelPlugin } from "../pluginTypes";
import type { ChannelAccount, TelegramChannelAccount } from "../types";
import { createTelegramAdapter } from "./adapter";
import { telegramMessageActions } from "./messageActions";
import { runTelegramSetup } from "./setup";

export const telegramChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "telegram",
    displayName: "Telegram",
    runtimePackages: ["grammy@1.42.0"],
    runtimeModules: ["grammy"],
  },
  createAdapter(account: ChannelAccount) {
    return createTelegramAdapter(account as TelegramChannelAccount);
  },
  messageActions: telegramMessageActions,
  runSetup() {
    return runTelegramSetup();
  },
};
