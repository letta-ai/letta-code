import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getChannelsRoot } from "./config";
import type { ChannelSubagentNoticeRoute } from "./gateway-subagent-notices";

/** A malformed file disables all notices; it never broadens authorization. */
export function parseSubagentNoticeConfig(
  value: unknown,
): ChannelSubagentNoticeRoute[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const config = value as Record<string, unknown>;
  if (
    Object.keys(config).some((key) => key !== "version" && key !== "routes") ||
    config.version !== 1 ||
    !Array.isArray(config.routes) ||
    config.routes.length > 4096
  )
    return [];
  const routes: ChannelSubagentNoticeRoute[] = [];
  const keys = [
    "channel",
    "accountId",
    "chatId",
    "agentId",
    "conversationId",
  ] as const;
  for (const item of config.routes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const route = item as Record<string, unknown>;
    if (
      keys.some(
        (key) =>
          typeof route[key] !== "string" ||
          !(route[key] as string).trim() ||
          (route[key] as string).includes("*"),
      )
    )
      return [];
    if (
      route.threadId !== null &&
      (typeof route.threadId !== "string" ||
        !route.threadId.trim() ||
        route.threadId.includes("*"))
    )
      return [];
    if (Object.keys(route).some((key) => ![...keys, "threadId"].includes(key)))
      return [];
    routes.push({
      channel: route.channel as string,
      accountId: route.accountId as string,
      chatId: route.chatId as string,
      threadId: route.threadId as string | null,
      agentId: route.agentId as string,
      conversationId: route.conversationId as string,
    });
  }
  return routes;
}

/** Read on observation and delivery so removing consent takes effect without restart. */
export function readSubagentNoticeRoutes(
  path = join(getChannelsRoot(), "subagent-notices.json"),
): ChannelSubagentNoticeRoute[] {
  try {
    return parseSubagentNoticeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
}
