import type { ChannelPlugin } from "@/channels/plugin-types";
import type { ChannelAccount, CustomChannelAccount } from "@/channels/types";
import { readXChatAccountSettings } from "./account";
import { createXChatAdapter } from "./adapter";
import { xchatMessageActions } from "./message-actions";
import { loadXChatXdkModule } from "./runtime";
import { XCHAT_CONFIG_SCHEMA } from "./schema";
import { runXChatSetup } from "./setup";

export const xchatChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "xchat",
    displayName: "X Chat",
    runtimePackages: [
      "@chat-adapter/x@4.38.1",
      "@xdevplatform/chat-xdk@0.5.0",
      "@xdevplatform/xdk@0.6.6",
      "juicebox-sdk@0.3.7",
    ],
    runtimeModules: ["@chat-adapter/x/chat", "@xdevplatform/xdk"],
    source: "first-party",
    firstParty: true,
    configSchema: XCHAT_CONFIG_SCHEMA,
  },
  createAdapter(account: ChannelAccount) {
    return createXChatAdapter(account as CustomChannelAccount);
  },
  async resolveAccountDisplayName(account: ChannelAccount) {
    const settings = readXChatAccountSettings(account as CustomChannelAccount);
    if (!settings.botToken) return undefined;
    const xdk = await loadXChatXdkModule();
    const client = new xdk.Client({ accessToken: settings.botToken });
    const me = await client.users.getMe();
    return me.data?.username ? `@${me.data.username}` : undefined;
  },
  messageActions: xchatMessageActions,
  runSetup() {
    return runXChatSetup();
  },
};
