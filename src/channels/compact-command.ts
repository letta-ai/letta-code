import { getChannelDisplayName } from "./plugin-registry";

function channelDisplayName(channelId: string): string {
  try {
    return getChannelDisplayName(channelId);
  } catch {
    return channelId;
  }
}

export function buildChannelCompactUnavailableMessage(
  channelId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} cannot use /compact because the listener is not ready yet. Try again in a moment.`;
}
