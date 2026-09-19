import { isRecord } from "@/utils/type-guards";

export const FEISHU_BOT_INFO_PATH = "/open-apis/bot/v3/info";

export interface FeishuBotInfo {
  openId?: string;
  name?: string;
}

function asBotRecord(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (isRecord(payload.bot)) {
    return payload.bot;
  }
  if (isRecord(payload.data) && isRecord(payload.data.bot)) {
    return payload.data.bot;
  }
  if (isRecord(payload.data)) {
    return payload.data;
  }
  return payload;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Parse `GET /open-apis/bot/v3/info`. Bot mentions in
 * `im.message.receive_v1` are identified by `mentions[].id.open_id`,
 * which is this `open_id` — not a `mentioned_type` field.
 */
export function parseFeishuBotInfo(payload: unknown): FeishuBotInfo {
  const bot = asBotRecord(payload);
  if (!bot) {
    return {};
  }
  return {
    openId: readTrimmedString(bot.open_id) ?? readTrimmedString(bot.openId),
    name:
      readTrimmedString(bot.app_name) ??
      readTrimmedString(bot.appName) ??
      readTrimmedString(bot.name),
  };
}
