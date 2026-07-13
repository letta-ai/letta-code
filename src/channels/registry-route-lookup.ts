import { LEGACY_CHANNEL_ACCOUNT_ID } from "./accounts";
import {
  getRoute as getRouteFromStore,
  getRouteRaw,
  loadRoutes,
} from "./routing";
import type { ChannelRoute, InboundChannelMessage } from "./types";

type InboundRouteLookupMessage = Pick<
  InboundChannelMessage,
  "channel" | "accountId" | "chatId" | "chatType" | "threadId"
>;

function shouldFallbackTelegramDirectTopicToRoot(
  msg: InboundRouteLookupMessage,
): boolean {
  return (
    msg.channel === "telegram" &&
    msg.chatType === "direct" &&
    !!msg.threadId?.trim()
  );
}

export function getRouteForInboundMessage(
  msg: InboundRouteLookupMessage,
): ChannelRoute | null {
  const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
  const exactRawRoute = getRouteRaw(
    msg.channel,
    msg.chatId,
    accountId,
    msg.threadId,
  );
  const exactRoute = getRouteFromStore(
    msg.channel,
    msg.chatId,
    accountId,
    msg.threadId,
  );
  if (exactRoute) {
    return exactRoute;
  }

  if (exactRawRoute || !shouldFallbackTelegramDirectTopicToRoot(msg)) {
    return null;
  }

  return getRouteFromStore(msg.channel, msg.chatId, accountId, null);
}

export function getRawRouteForInboundMessage(
  msg: InboundRouteLookupMessage,
): ChannelRoute | null {
  const accountId = msg.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
  const exactRoute =
    getRouteRaw(msg.channel, msg.chatId, accountId, msg.threadId) ?? null;
  if (exactRoute) {
    return exactRoute;
  }

  if (!shouldFallbackTelegramDirectTopicToRoot(msg)) {
    return null;
  }

  return getRouteRaw(msg.channel, msg.chatId, accountId, null) ?? null;
}

export function loadAndGetRouteForInboundMessage(
  msg: InboundRouteLookupMessage,
): ChannelRoute | null {
  const route = getRouteForInboundMessage(msg);
  if (route) {
    return route;
  }

  loadRoutes(msg.channel);
  return getRouteForInboundMessage(msg);
}

export function loadAndGetRawRouteForInboundMessage(
  msg: InboundRouteLookupMessage,
): ChannelRoute | null {
  const route = getRawRouteForInboundMessage(msg);
  if (route) {
    return route;
  }

  loadRoutes(msg.channel);
  return getRawRouteForInboundMessage(msg);
}
