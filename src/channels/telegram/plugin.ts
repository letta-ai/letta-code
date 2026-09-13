import type { ChannelPlugin } from "@/channels/plugin-types";
import type { ChannelAccount, TelegramChannelAccount } from "@/channels/types";
import { validateTelegramToken } from "./account-display";
import { createTelegramAdapter } from "./adapter";
import { telegramMessageActions } from "./message-actions";
import { runTelegramSetup } from "./setup";

export const telegramChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "telegram",
    displayName: "Telegram",
    runtimePackages: ["grammy@1.42.0"],
    runtimeModules: ["grammy"],
    source: "first-party",
    firstParty: true,
  },
  createAdapter(account: ChannelAccount) {
    return createTelegramAdapter(account as TelegramChannelAccount);
  },
  async resolveAccountDisplayName(account: ChannelAccount) {
    const telegram = account as TelegramChannelAccount;
    if (!telegram.token.trim()) return undefined;
    const info = await validateTelegramToken(telegram.token);
    return info.username ? `@${info.username}` : undefined;
  },
  messageActions: telegramMessageActions,
  runSetup() {
    return runTelegramSetup();
  },
};
