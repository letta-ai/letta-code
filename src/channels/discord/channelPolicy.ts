/**
 * Discord guild-channel policy gate.
 *
 * Determines whether a guild channel message should be passed to the inbound
 * pipeline based on the account's configured `channelPolicy`.
 *
 * - `"mention"` (default): only process messages that are inside a thread
 *   already, or that @-mention the bot. Preserves the legacy adapter
 *   behavior where the bot stays quiet in guild channels until summoned.
 * - `"open"`: process every guild message that passes other gates
 *   (bot-author check, `allowedChannels`, etc.). Useful for dedicated
 *   single-purpose channels where the bot is meant to be conversational.
 *
 * DMs ignore this gate entirely — gate them at the call site by checking
 * chat type first. This module is intentionally a tiny pure function so
 * it composes cleanly with `isDiscordGuildChannelAllowed`.
 */

import type { DiscordChannelPolicy } from "../types";

export interface DiscordChannelPolicyParams {
  /** Whether the message arrived inside a Discord thread. */
  isThread: boolean;
  /** Whether the bot was @-mentioned in this message. */
  wasMentioned: boolean;
  /**
   * The account's configured policy. Undefined defaults to `"mention"` so
   * that existing accounts persisted before this field was introduced
   * preserve the original behavior.
   */
  channelPolicy?: DiscordChannelPolicy;
}

/**
 * Returns true when the message should be processed, false when the gate
 * blocks it. Messages outside guilds (DMs) should not be passed through
 * this helper — gate them at the call site by checking chat type first.
 */
export function shouldProcessGuildMessage(
  params: DiscordChannelPolicyParams,
): boolean {
  const { isThread, wasMentioned, channelPolicy } = params;
  const policy: DiscordChannelPolicy = channelPolicy ?? "mention";
  if (policy === "open") return true;
  return isThread || wasMentioned;
}
