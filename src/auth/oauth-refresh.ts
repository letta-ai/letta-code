import { refreshAccessToken, type TokenResponse } from "@/auth/oauth";

type RefreshAccessToken = typeof refreshAccessToken;

const inFlightRefreshes = new Map<string, Promise<TokenResponse>>();

export async function refreshAccessTokenSingleFlight(
  refreshToken: string,
  deviceId: string,
  deviceName?: string,
  refresh: RefreshAccessToken = refreshAccessToken,
): Promise<TokenResponse> {
  const refreshKey = `${refreshToken}\0${deviceId}`;
  const existing = inFlightRefreshes.get(refreshKey);
  if (existing) {
    return await existing;
  }

  const pending = refresh(refreshToken, deviceId, deviceName);
  inFlightRefreshes.set(refreshKey, pending);
  try {
    return await pending;
  } finally {
    if (inFlightRefreshes.get(refreshKey) === pending) {
      inFlightRefreshes.delete(refreshKey);
    }
  }
}
