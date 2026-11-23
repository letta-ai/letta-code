export const CHANNEL_ROOT_THREAD_KEY = "__root__";

export function resolveChannelRouteThreadKey(threadId?: string | null): string {
  const trimmed = threadId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : CHANNEL_ROOT_THREAD_KEY;
}

export function channelRouteThreadIdFromKey(
  threadKey?: string | null,
): string | null {
  const trimmed = threadKey?.trim();
  if (!trimmed || trimmed === CHANNEL_ROOT_THREAD_KEY) return null;
  return trimmed;
}
