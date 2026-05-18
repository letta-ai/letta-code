/**
 * Discord guild-channel allowlist gating.
 *
 * When a Discord account has `allowedChannels` configured, only messages whose
 * channel ID — or parent channel ID for thread messages — appears in the list
 * are processed by the bot. Empty/undefined preserves the default behavior of
 * listening in every guild channel the bot can see. DMs ignore this gate
 * entirely.
 */

export interface DiscordChannelGateParams {
  /** ID of the channel the message arrived in. For thread messages this is the thread's channel ID. */
  channelId: string;
  /** Parent channel ID when the message is in a thread; null otherwise. */
  parentChannelId: string | null;
  /** Whether the message is in a thread. */
  isThread: boolean;
  /** The configured allowlist (may be empty/undefined to mean "no gate"). */
  allowedChannels?: string[];
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
  if (!allowedChannels || allowedChannels.length === 0) {
    return true;
  }
  const gateChannelId = isThread ? (parentChannelId ?? channelId) : channelId;
  return allowedChannels.includes(gateChannelId);
}
