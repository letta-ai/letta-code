import { describe, expect, mock, test } from "bun:test";
import type { TokenResponse } from "@/auth/oauth";
import { refreshAccessTokenSingleFlight } from "@/auth/oauth-refresh";

describe("refreshAccessTokenSingleFlight", () => {
  test("coalesces refreshes for the same rotating credential", async () => {
    let resolveRefresh: ((tokens: TokenResponse) => void) | undefined;
    const refresh = mock(
      () =>
        new Promise<TokenResponse>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const first = refreshAccessTokenSingleFlight(
      "refresh-token",
      "device-id",
      "listener-name",
      refresh,
    );
    const second = refreshAccessTokenSingleFlight(
      "refresh-token",
      "device-id",
      "hostname",
      refresh,
    );

    expect(refresh).toHaveBeenCalledTimes(1);
    resolveRefresh?.({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
    });

    expect(await first).toEqual(await second);
  });
});
