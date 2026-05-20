import type { DiscordChannelAccount } from "../types";

const DISCORD_DEBOUNCE_DEFAULT_MS = 0;
const DISCORD_DEBOUNCE_MAX_MS = 10000;

/**
 * Resolve the inbound debounce window for Discord.
 *
 * Priority: env var > account config > default (disabled).
 * Returns `0` to disable. Clamped to `0..10000`.
 */
export function resolveDiscordInboundDebounceMs(
  config: Pick<DiscordChannelAccount, "inboundDebounceMs">,
): number {
  const raw = process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS;
  if (typeof raw === "string" && raw.trim() !== "") {
    const envOverride = Number(raw);
    if (Number.isFinite(envOverride) && envOverride >= 0) {
      return Math.trunc(Math.min(envOverride, DISCORD_DEBOUNCE_MAX_MS));
    }
  }
  const fromConfig = config.inboundDebounceMs;
  if (
    typeof fromConfig === "number" &&
    Number.isFinite(fromConfig) &&
    fromConfig >= 0
  ) {
    return Math.trunc(Math.min(fromConfig, DISCORD_DEBOUNCE_MAX_MS));
  }
  return DISCORD_DEBOUNCE_DEFAULT_MS;
}

export type DiscordDebounceRawInput = {
  channelId: string;
  threadId: string | null;
};

/**
 * Build the key used to group inbound Discord messages for debounced
 * stacking. Keyed by (accountId, effective chat/thread) so that messages
 * from different senders in the same channel merge together (with sender
 * labels on flush). Different channels and threads never merge.
 */
export function buildDiscordDebounceKey(
  rawMessage: DiscordDebounceRawInput,
  accountId: string,
): string | null {
  const scope = rawMessage.threadId ?? rawMessage.channelId;
  if (!scope) return null;
  return `discord:${accountId}:${scope}`;
}

export { DISCORD_DEBOUNCE_DEFAULT_MS, DISCORD_DEBOUNCE_MAX_MS };
