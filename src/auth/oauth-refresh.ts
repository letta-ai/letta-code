import { refreshAccessToken, type TokenResponse } from "@/auth/oauth";

type RefreshAccessToken = typeof refreshAccessToken;

const inFlightRefreshes = new Map<string, Promise<TokenResponse>>();

export async function refreshAccessTokenSingleFlight(
  refreshToken: string,
  deviceId: string,
  deviceName?: string,
  refresh: RefreshAccessToken = refreshAccessToken,
  options?: { signal?: AbortSignal },
): Promise<TokenResponse> {
  const refreshKey = `${refreshToken}\0${deviceId}`;
  const existing = inFlightRefreshes.get(refreshKey);
  if (existing) {
    return await existing;
  }

  // Only the starter's signal reaches the fetch (evil-shub round-9 P1): a
  // joiner cannot cancel a refresh others await, and the fetch carries its
  // own static ceiling so an un-signaled starter still cannot hang forever.
  // Keep the legacy three-argument call shape when no budget was provided so
  // existing test doubles and wrappers observe no signature change.
  const pending = options?.signal
    ? refresh(refreshToken, deviceId, deviceName, options.signal)
    : refresh(refreshToken, deviceId, deviceName);
  inFlightRefreshes.set(refreshKey, pending);
  try {
    return await pending;
  } finally {
    if (inFlightRefreshes.get(refreshKey) === pending) {
      inFlightRefreshes.delete(refreshKey);
    }
  }
}
