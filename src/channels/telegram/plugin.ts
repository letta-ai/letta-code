import type { ChannelPlugin } from "../pluginTypes";
import type { ChannelConfig } from "../types";
import { createTelegramAdapter } from "./adapter";
import { runTelegramSetup } from "./setup";

export const telegramChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "telegram",
    displayName: "Telegram",
    runtimePackages: ["grammy@1.42.0"],
    runtimeModules: ["grammy"],
  },
  createAdapter(config: ChannelConfig) {
    return createTelegramAdapter(config);
  },
  runSetup() {
    return runTelegramSetup();
  },
};
