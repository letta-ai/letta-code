import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  pollForToken,
  refreshAccessToken,
  requestDeviceCode,
  validateCredentialsWithResult,
} from "@/auth/oauth";

const originalFetch = globalThis.fetch;

function makeFetchFailure(message: string, code?: string): Error {
  const cause = Object.assign(new Error(message), code ? { code } : {});
  return new TypeError("fetch failed", { cause });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OAuth network errors", () => {
  test("requestDeviceCode includes auth host and network detail", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(
        makeFetchFailure("getaddrinfo ENOTFOUND app.letta.com", "ENOTFOUND"),
      ),
    ) as unknown as typeof fetch;

    try {
      await requestDeviceCode();
      throw new Error("Expected requestDeviceCode to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(
        "Failed to request device code from app.letta.com: getaddrinfo ENOTFOUND app.letta.com.",
      );
      expect(message).toContain(
        "Check your network, DNS, proxy, VPN, or TLS settings.",
      );
    }
  });

  test("pollForToken explains that browser auth may have succeeded", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(
        makeFetchFailure("connect ECONNRESET 104.18.34.223:443", "ECONNRESET"),
      ),
    ) as unknown as typeof fetch;

    try {
      await pollForToken("device-code", 0, 60, "device-id");
      throw new Error("Expected pollForToken to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(
        "Failed to poll for OAuth token from app.letta.com: connect ECONNRESET 104.18.34.223:443.",
      );
      expect(message).toContain(
        "Browser authorization may have succeeded, but the CLI could not reach Letta auth servers from this machine.",
      );
    }
  });

  test("refreshAccessToken includes auth host and low-level cause", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(
        makeFetchFailure("certificate has expired", "CERT_HAS_EXPIRED"),
      ),
    ) as unknown as typeof fetch;

    await expect(
      refreshAccessToken("refresh-token", "device-id", "device-name"),
    ).rejects.toThrow(
      "Failed to refresh access token from app.letta.com: certificate has expired (CERT_HAS_EXPIRED).",
    );
  });

  test("validateCredentialsWithResult classifies authentication failures", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const result = await validateCredentialsWithResult(
      "https://api.letta.com",
      "bad-key",
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "invalid_credentials",
      status: 401,
    });
  });

  test("pollForToken preserves non-network OAuth errors", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "access_denied" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    await expect(
      pollForToken("device-code", 0, 60, "device-id"),
    ).rejects.toThrow("User denied authorization");
  });

  test("pollForToken shares concurrent polls for the same device code", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const [first, second] = await Promise.all([
      pollForToken("shared-device-code", 0, 60, "device-id"),
      pollForToken("shared-device-code", 0, 60, "device-id"),
    ]);

    expect(first.access_token).toBe("access-token");
    expect(second.access_token).toBe("access-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("pollForToken reports already-used device codes clearly", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "already_used" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    await expect(
      pollForToken("already-used-device-code", 0, 60, "device-id"),
    ).rejects.toThrow("Device code was already used before Letta Code");
  });

  test("pollForToken supports cancellation via AbortSignal", async () => {
    const controller = new AbortController();
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const promise = pollForToken(
      "device-code",
      1,
      60,
      "device-id",
      undefined,
      controller.signal,
    );
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
