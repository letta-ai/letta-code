import type { ChannelTurnSource } from "./types";

export function sourceRouteKey(source: ChannelTurnSource): string {
  return [
    source.channel,
    source.accountId ?? "",
    source.chatId,
    source.threadId ?? "",
  ].join(":");
}

export function sourceLifecycleKey(source: ChannelTurnSource): string {
  return [
    sourceRouteKey(source),
    source.messageId ?? "",
    source.agentId,
    source.conversationId,
  ].join(":");
}

function uniqueSourcesBy(
  sources: ChannelTurnSource[],
  getKey: (source: ChannelTurnSource) => string,
): ChannelTurnSource[] {
  const byKey = new Map<string, ChannelTurnSource>();
  for (const source of sources) byKey.set(getKey(source), source);
  return [...byKey.values()];
}

export function uniqueRoutedSources(
  sources: ChannelTurnSource[],
): ChannelTurnSource[] {
  return uniqueSourcesBy(sources, sourceRouteKey);
}

export function uniqueLifecycleSources(
  sources: ChannelTurnSource[],
): ChannelTurnSource[] {
  return uniqueSourcesBy(sources, sourceLifecycleKey);
}

export function channelTagsForSources(sources: ChannelTurnSource[]): string[] {
  return [...new Set(sources.map((source) => `channel:${source.channel}`))];
}
