import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  OAuthRefreshError,
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

function makeHtmlGatewayError(headers?: Record<string, string>): Response {
  return new Response(
    "<!DOCTYPE html><html><title>Bad Gateway body marker</title></html>",
    {
      status: 502,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...headers,
      },
    },
  );
}

function makeJsonTransientError(headers?: Record<string, string>): Response {
  return new Response(
    JSON.stringify({
      error: "temporarily_unavailable",
      error_description: "JSON transient body marker",
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    },
  );
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

  test("requestDeviceCode retries non-JSON server responses before actionable error", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(makeHtmlGatewayError({ "cf-ray": "abc123-SJC" })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let failure: unknown;
    try {
      await requestDeviceCode();
    } catch (error) {
      failure = error;
    }

    const message =
      failure instanceof Error ? failure.message : String(failure);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(message).toContain(
      "Failed to request device code from app.letta.com",
    );
    expect(message).toContain("HTTP 502");
    expect(message).toContain("media type text/html");
    expect(message).toContain("request id cf-ray=abc123-SJC");
    expect(message).toContain("Try again later");
    expect(message).not.toContain("<!DOCTYPE");
    expect(message).not.toContain("Bad Gateway body marker");
    expect(message).not.toContain("Unexpected token");
  });

  test("requestDeviceCode retries JSON 5xx before safe actionable error", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(makeJsonTransientError({ "x-request-id": "req-503" })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let failure: unknown;
    try {
      await requestDeviceCode();
    } catch (error) {
      failure = error;
    }

    const message =
      failure instanceof Error ? failure.message : String(failure);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(message).toContain(
      "Failed to request device code from app.letta.com",
    );
    expect(message).toContain("received transient OAuth response");
    expect(message).toContain("HTTP 503");
    expect(message).toContain("media type application/json");
    expect(message).toContain("request id x-request-id=req-503");
    expect(message).not.toContain("temporarily_unavailable");
    expect(message).not.toContain("JSON transient body marker");
  });

  test("pollForToken recovers from bounded transient response failures", async () => {
    let calls = 0;
    const fetchMock = mock(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(makeHtmlGatewayError());
      }

      if (calls === 2) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "authorization_pending" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      if (calls === 3 || calls === 4) {
        return Promise.resolve(makeJsonTransientError());
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      pollForToken("device-code", 0, 60, "device-id"),
    ).resolves.toMatchObject({ access_token: "access-token" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test("pollForToken bounds persistent non-JSON response failures", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        makeHtmlGatewayError({ "x-vercel-id": "sfo1::iad1::oauth123" }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let failure: unknown;
    try {
      await pollForToken("device-code", 0, 60, "device-id");
    } catch (error) {
      failure = error;
    }

    const message =
      failure instanceof Error ? failure.message : String(failure);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(message).toContain(
      "Failed to poll for OAuth token from app.letta.com",
    );
    expect(message).toContain("HTTP 502");
    expect(message).toContain("media type text/html");
    expect(message).toContain("request id x-vercel-id=sfo1::iad1::oauth123");
    expect(message).not.toContain("<!DOCTYPE");
    expect(message).not.toContain("Bad Gateway body marker");
    expect(message).not.toContain("Unexpected token");
  });

  test("pollForToken bounds persistent JSON transient response failures", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        makeJsonTransientError({ "x-request-id": "poll-json-503" }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let failure: unknown;
    try {
      await pollForToken("device-code", 0, 60, "device-id");
    } catch (error) {
      failure = error;
    }

    const message =
      failure instanceof Error ? failure.message : String(failure);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(message).toContain(
      "Failed to poll for OAuth token from app.letta.com",
    );
    expect(message).toContain("received transient OAuth response");
    expect(message).toContain("HTTP 503");
    expect(message).toContain("media type application/json");
    expect(message).toContain("request id x-request-id=poll-json-503");
    expect(message).not.toContain("temporarily_unavailable");
    expect(message).not.toContain("JSON transient body marker");
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

    let refreshError: unknown;
    try {
      await refreshAccessToken("refresh-token", "device-id", "device-name");
    } catch (error) {
      refreshError = error;
    }
    expect(refreshError).toBeInstanceOf(OAuthRefreshError);
    expect((refreshError as OAuthRefreshError).message).toContain(
      "Failed to refresh access token from app.letta.com: certificate has expired (CERT_HAS_EXPIRED).",
    );
    expect((refreshError as OAuthRefreshError).retryable).toBe(true);
  });

  test("refreshAccessToken distinguishes revoked credentials from server failures", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    try {
      await refreshAccessToken("revoked", "device-id");
      throw new Error("Expected revoked refresh to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthRefreshError);
      expect((error as OAuthRefreshError).retryable).toBe(false);
      expect((error as OAuthRefreshError).oauthCode).toBe("invalid_grant");
    }

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    try {
      await refreshAccessToken("valid", "device-id");
      throw new Error("Expected server failure to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthRefreshError);
      expect((error as OAuthRefreshError).retryable).toBe(true);
      expect((error as OAuthRefreshError).status).toBe(503);
    }
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
