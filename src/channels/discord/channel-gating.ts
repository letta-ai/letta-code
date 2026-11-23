import type { DiscordChannelMode } from "@/channels/types";

function resolveGateChannelId(
  channelId: string,
  parentChannelId: string | null,
  isThread: boolean,
): string {
  return isThread ? (parentChannelId ?? channelId) : channelId;
}

function isLegacyStringArray(
  allowedChannels: unknown,
): allowedChannels is string[] {
  return Array.isArray(allowedChannels);
}

function isModeMap(
  allowedChannels: unknown,
): allowedChannels is Record<string, DiscordChannelMode> {
  return (
    !!allowedChannels &&
    typeof allowedChannels === "object" &&
    !Array.isArray(allowedChannels)
  );
}

export interface DiscordChannelGateParams {
  channelId: string;
  parentChannelId: string | null;
  isThread: boolean;
  allowedChannels?: string[] | Record<string, DiscordChannelMode>;
}

export function isDiscordGuildChannelAllowed(
  params: DiscordChannelGateParams,
): boolean {
  const { channelId, parentChannelId, isThread, allowedChannels } = params;
  if (!allowedChannels) {
    return true;
  }
  if (isLegacyStringArray(allowedChannels)) {
    if (allowedChannels.length === 0) {
      return true;
    }
    const gateChannelId = resolveGateChannelId(
      channelId,
      parentChannelId,
      isThread,
    );
    return allowedChannels.includes(gateChannelId);
  }
  if (isModeMap(allowedChannels)) {
    if (Object.keys(allowedChannels).length === 0) {
      return true;
    }
    const gateChannelId = resolveGateChannelId(
      channelId,
      parentChannelId,
      isThread,
    );
    return gateChannelId in allowedChannels || "*" in allowedChannels;
  }
  return true;
}

export function resolveDiscordChannelMode(
  channelId: string,
  parentChannelId: string | null,
  isThread: boolean,
  allowedChannels?: string[] | Record<string, DiscordChannelMode>,
): DiscordChannelMode | null {
  if (!allowedChannels) {
    return null;
  }
  const gateChannelId = resolveGateChannelId(
    channelId,
    parentChannelId,
    isThread,
  );
  if (isLegacyStringArray(allowedChannels)) {
    if (allowedChannels.length === 0) {
      return null;
    }
    return allowedChannels.includes(gateChannelId) ? "mention-only" : null;
  }
  if (isModeMap(allowedChannels)) {
    if (Object.keys(allowedChannels).length === 0) {
      return null;
    }
    return allowedChannels[gateChannelId] ?? allowedChannels["*"] ?? null;
  }
  return null;
}
