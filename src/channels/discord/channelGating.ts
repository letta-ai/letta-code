/**
 * Discord guild-channel gating and mode resolution.
 *
 * When a Discord account has `allowedChannels` configured, only messages whose
 * channel ID — or parent channel ID for thread messages — appears in the list
 * are processed by the bot. Empty/undefined preserves the default behavior of
 * listening in every guild channel the bot can see. DMs ignore this gate
 * entirely.
 *
 * `allowedChannels` accepts two formats:
 *   - Legacy `string[]`: simple allowlist, all entries default to "mention-only"
 *   - `Record<channelId, mode>`: per-channel mode map
 */

import type { DiscordChannelMode } from "../types";

/** Resolved channel ID for gating purposes (thread → parent fallback). */
function resolveGateChannelId(
  channelId: string,
  parentChannelId: string | null,
  isThread: boolean,
): string {
  return isThread ? (parentChannelId ?? channelId) : channelId;
}

/**
 * Returns true when `allowedChannels` looks like the legacy `string[]` format.
 */
function isLegacyStringArray(
  allowedChannels: unknown,
): allowedChannels is string[] {
  return Array.isArray(allowedChannels);
}

/**
 * Returns true when `allowedChannels` looks like the mode map format.
 */
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
  /** ID of the channel the message arrived in. For thread messages this is the thread's channel ID. */
  channelId: string;
  /** Parent channel ID when the message is in a thread; null otherwise. */
  parentChannelId: string | null;
  /** Whether the message is in a thread. */
  isThread: boolean;
  /** The configured allowlist or mode map (may be empty/undefined to mean "no gate"). */
  allowedChannels?: string[] | Record<string, DiscordChannelMode>;
}

/**
 * Returns true when the message should be processed, false when the gate
 * blocks it. Messages outside guilds (DMs) should not be passed through this
 * helper — gate them at the call site by checking chat type first.
 */
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

/**
 * Resolve the channel mode for a given guild channel.
 *
 * Returns:
 *   - `"open"` or `"mention-only"` when the channel is found in the mode map
 *   - `"mention-only"` when the channel appears in a legacy `string[]` allowlist
 *   - `null` when no gate is configured (allowedChannels is undefined/empty)
 *     or the channel is not found in the map
 */
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
