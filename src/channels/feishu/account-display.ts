import type { FeishuDomain } from "@/channels/types";
import { isRecord } from "@/utils/type-guards";
import { loadFeishuModule, resolveFeishuSdkDomain } from "./runtime";

function readBotName(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const bot = isRecord(payload.bot) ? payload.bot : payload;
  const name =
    (typeof bot.app_name === "string" && bot.app_name.trim()) ||
    (typeof bot.name === "string" && bot.name.trim()) ||
    (isRecord(payload.data) &&
      typeof payload.data.app_name === "string" &&
      payload.data.app_name.trim()) ||
    "";
  return name || undefined;
}

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
      url: "/open-apis/bot/v3/info",
      method: "GET",
    });
    return readBotName(result);
  } catch {
    return undefined;
  }
}
