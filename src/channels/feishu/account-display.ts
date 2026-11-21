import type { FeishuDomain } from "@/channels/types";
import { FEISHU_BOT_INFO_PATH, parseFeishuBotInfo } from "./bot-info";
import { loadFeishuModule, resolveFeishuSdkDomain } from "./runtime";

export async function resolveFeishuAccountDisplayName(options: {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
}): Promise<string | undefined> {
  if (!options.appId.trim() || !options.appSecret.trim()) {
    return undefined;
  }
  try {
    const Lark = await loadFeishuModule();
    const client = new Lark.Client({
      appId: options.appId.trim(),
      appSecret: options.appSecret.trim(),
      domain: resolveFeishuSdkDomain(options.domain, Lark),
      ...(Lark.AppType?.SelfBuild ? { appType: Lark.AppType.SelfBuild } : {}),
    });
    if (typeof client.request !== "function") {
      return undefined;
    }
    const result = await client.request({
      url: FEISHU_BOT_INFO_PATH,
      method: "GET",
    });
    return parseFeishuBotInfo(result).name;
  } catch {
    return undefined;
  }
}
