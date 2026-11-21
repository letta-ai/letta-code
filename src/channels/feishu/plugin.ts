import type { ChannelPlugin } from "@/channels/plugin-types";
import type { ChannelAccount, FeishuChannelAccount } from "@/channels/types";
import { resolveFeishuAccountDisplayName } from "./account-display";
import { createFeishuAdapter } from "./adapter";
import { FEISHU_CONFIG_SCHEMA } from "./config-schema";
import {
  FEISHU_RUNTIME_MODULE,
  FEISHU_RUNTIME_PACKAGE,
} from "./internal-types";
import { feishuMessageActions } from "./message-actions";
import { runFeishuSetup } from "./setup";

export const feishuChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "feishu",
    displayName: "Feishu / Lark",
    runtimePackages: [FEISHU_RUNTIME_PACKAGE],
    runtimeModules: [FEISHU_RUNTIME_MODULE],
    source: "first-party",
    firstParty: true,
    configSchema: FEISHU_CONFIG_SCHEMA,
  },
  createAdapter(account: ChannelAccount) {
    return createFeishuAdapter(account as FeishuChannelAccount);
  },
  resolveAccountDisplayName(account: ChannelAccount) {
    const feishu = account as FeishuChannelAccount;
    if (!feishu.appId.trim() || !feishu.appSecret.trim()) return undefined;
    return resolveFeishuAccountDisplayName({
      appId: feishu.appId,
      appSecret: feishu.appSecret,
      domain: feishu.domain,
    });
  },
  messageActions: feishuMessageActions,
  runSetup() {
    return runFeishuSetup();
  },
};
