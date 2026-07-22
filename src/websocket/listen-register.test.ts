import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  createListenerSessionNonce,
  deriveListenerInstanceId,
  isSupersededRegistrationError,
  registerWithCloud,
  registerWithCloudRetry,
  resolveListenerSurfaceFromEnv,
} from "@/websocket/listen-register";

const defaultOpts = {
  serverUrl: "https://api.example.com",
  apiKey: "sk-test-key",
  deviceId: "device-123",
  connectionName: "test-machine",
};

const mockFetch = mock(() => {
  throw new Error("fetch not mocked for this test");
});

beforeEach(() => {
  mockFetch.mockReset();
});

describe("registerWithCloud", () => {
  it("returns connectionId and wsUrl on successful JSON response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ connectionId: "conn-1", wsUrl: "wss://example.com" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await registerWithCloud(
      defaultOpts,
      mockFetch as unknown as typeof fetch,
    );

    expect(result).toEqual({
      connectionId: "conn-1",
      wsUrl: "wss://example.com",
      supportsSplitStatusChannels: false,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.example.com/v1/environments/register");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test-key",
    );
    expect((init.headers as Record<string, string>)["X-Letta-Source"]).toBe(
      "letta-code",
    );
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      deviceId: "device-123",
      connectionName: "test-machine",
      metadata: {
        lettaCodeVersion: expect.any(String),
        os: expect.any(String),
        nodeVersion: expect.any(String),
      },
    });
    // Not provided → omitted so legacy servers see an unchanged payload
    expect(body).not.toHaveProperty("listenerInstanceId");
  });

  it("includes listenerInstanceId in the payload when provided", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ connectionId: "conn-1", wsUrl: "wss://example.com" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await registerWithCloud(
      {
        ...defaultOpts,
        listenerInstanceId: deriveListenerInstanceId("server", "test-machine"),
      },
      mockFetch as unknown as typeof fetch,
    );

    const [, init] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string);
    expect(body.listenerInstanceId).toBe(
      deriveListenerInstanceId("server", "test-machine"),
    );
  });

  it("returns advertised split-channel support when present", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          connectionId: "conn-2",
          wsUrl: "wss://example.com",
          supportsSplitStatusChannels: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await registerWithCloud(
      defaultOpts,
      mockFetch as unknown as typeof fetch,
    );

    expect(result.supportsSplitStatusChannels).toBe(true);
  });

  it("throws with body message on non-OK response with JSON error", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      registerWithCloud(defaultOpts, mockFetch as unknown as typeof fetch),
    ).rejects.toThrow("Unauthorized");
  });

  it("throws with HTTP status and truncated body on non-OK non-JSON response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("<html>Bad Gateway</html>", { status: 502 }),
    );

    await expect(
      registerWithCloud(defaultOpts, mockFetch as unknown as typeof fetch),
    ).rejects.toThrow("HTTP 502: <html>Bad Gateway</html>");
  });

  it("throws actionable message on 200 with non-JSON body", async () => {
    mockFetch.mockResolvedValueOnce(new Response("OK", { status: 200 }));

    await expect(
      registerWithCloud(defaultOpts, mockFetch as unknown as typeof fetch),
    ).rejects.toThrow("is the server running?");
  });

  it("throws on unexpected response shape (missing fields)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ connectionId: "conn-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      registerWithCloud(defaultOpts, mockFetch as unknown as typeof fetch),
    ).rejects.toThrow("missing connectionId or wsUrl");
  });

  it("uses JSON error fields in rate limit messages", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error:
            "Rate limit exceeded for this endpoint. Please slow down and retry.",
          errorCode: "route_rps_rate_limit_exceeded",
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      registerWithCloud(defaultOpts, mockFetch as unknown as typeof fetch),
    ).rejects.toThrow("route_rps_rate_limit_exceeded");
  });

  it("retries rate limited registration instead of treating 429 as fatal", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error:
              "Rate limit exceeded for this endpoint. Please slow down and retry.",
            errorCode: "route_rps_rate_limit_exceeded",
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "3",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            connectionId: "conn-3",
            wsUrl: "wss://example.com",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const retryEvents: Array<{
      attempt: number;
      delayMs: number;
      message: string;
    }> = [];
    const slept: number[] = [];
    const result = await registerWithCloudRetry(defaultOpts, {
      fetchImpl: mockFetch as unknown as typeof fetch,
      random: () => 0,
      sleep: async (delayMs) => {
        slept.push(delayMs);
      },
      onRetry: (attempt, delayMs, error) => {
        retryEvents.push({ attempt, delayMs, message: error.message });
      },
    });

    expect(result.connectionId).toBe("conn-3");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([3000]);
    expect(retryEvents).toEqual([
      {
        attempt: 1,
        delayMs: 3000,
        message:
          "HTTP 429: Rate limit exceeded for this endpoint. Please slow down and retry. (route_rps_rate_limit_exceeded)",
      },
    ]);
  });

  it("retries 429 without Retry-After using exponential backoff", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error:
              "Rate limit exceeded for this endpoint. Please slow down and retry.",
            errorCode: "route_rps_rate_limit_exceeded",
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            connectionId: "conn-4",
            wsUrl: "wss://example.com",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const slept: number[] = [];

    const result = await registerWithCloudRetry(defaultOpts, {
      fetchImpl: mockFetch as unknown as typeof fetch,
      random: () => 0,
      sleep: async (delayMs) => {
        slept.push(delayMs);
      },
    });

    expect(result.connectionId).toBe("conn-4");
    expect(slept).toEqual([1000]);
  });

  it("adds bounded positive jitter to retry delays", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            connectionId: "conn-5",
            wsUrl: "wss://example.com",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const slept: number[] = [];

    await registerWithCloudRetry(defaultOpts, {
      fetchImpl: mockFetch as unknown as typeof fetch,
      random: () => 0.5,
      sleep: async (delayMs) => {
        slept.push(delayMs);
      },
    });

    expect(slept).toEqual([1125]);
  });
});

describe("deriveListenerInstanceId", () => {
  it("is deterministic for the same surface and name", () => {
    expect(deriveListenerInstanceId("server", "mac-mini")).toBe(
      deriveListenerInstanceId("server", "mac-mini"),
    );
  });

  it("differs across surfaces and across names", () => {
    const server = deriveListenerInstanceId("server", "mac-mini");
    expect(deriveListenerInstanceId("listen", "mac-mini")).not.toBe(server);
    expect(deriveListenerInstanceId("server", "other-name")).not.toBe(server);
  });

  it("produces a compact prefixed id", () => {
    expect(deriveListenerInstanceId("server", "mac-mini")).toMatch(
      /^server-[0-9a-f]{16}$/,
    );
  });
});

describe("supersession (LET-10024)", () => {
  it("sends the session nonce with registration when provided", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ connectionId: "conn-1", wsUrl: "wss://example.com" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const sessionNonce = createListenerSessionNonce();
    await registerWithCloud(
      { ...defaultOpts, sessionNonce },
      mockFetch as unknown as typeof fetch,
    );

    const [, init] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string);
    expect(body.processInstanceId).toBe(sessionNonce);
    expect(body.processInstanceId).toMatch(/^proc-/);
  });

  it("omits the nonce when the caller does not provide one", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ connectionId: "conn-1", wsUrl: "wss://example.com" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await registerWithCloud(defaultOpts, mockFetch as unknown as typeof fetch);

    const [, init] = mockFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string);
    expect(body.processInstanceId).toBeUndefined();
  });

  it("mints a distinct nonce per session", () => {
    expect(createListenerSessionNonce()).not.toBe(createListenerSessionNonce());
  });

  it("classifies 409 LISTENER_SUPERSEDED as a superseded registration error", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          errorCode: "LISTENER_SUPERSEDED",
          message: "This listener process was superseded by a newer listener.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );

    let caught: unknown;
    try {
      await registerWithCloud(
        defaultOpts,
        mockFetch as unknown as typeof fetch,
      );
    } catch (error) {
      caught = error;
    }
    expect(isSupersededRegistrationError(caught)).toBe(true);
  });

  it("does NOT retry a 409 LISTENER_SUPERSEDED (terminal, not transient)", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          errorCode: "LISTENER_SUPERSEDED",
          message: "Superseded.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );

    let caught: unknown;
    try {
      await registerWithCloudRetry(defaultOpts, {
        fetchImpl: mockFetch as unknown as typeof fetch,
        sleep: async () => {},
      });
    } catch (error) {
      caught = error;
    }
    expect(isSupersededRegistrationError(caught)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("other 409s are not classified as superseded", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ errorCode: "CONFLICT", message: "Busy" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );

    let caught: unknown;
    try {
      await registerWithCloud(
        defaultOpts,
        mockFetch as unknown as typeof fetch,
      );
    } catch (error) {
      caught = error;
    }
    expect(isSupersededRegistrationError(caught)).toBe(false);
  });
});

describe("resolveListenerSurfaceFromEnv", () => {
  it("honors LETTA_LISTENER_SURFACE when it names a known surface", () => {
    const prev = process.env.LETTA_LISTENER_SURFACE;
    try {
      process.env.LETTA_LISTENER_SURFACE = "desktop-remote";
      expect(resolveListenerSurfaceFromEnv("server")).toBe("desktop-remote");
    } finally {
      if (prev === undefined) {
        delete process.env.LETTA_LISTENER_SURFACE;
      } else {
        process.env.LETTA_LISTENER_SURFACE = prev;
      }
    }
  });

  it("falls back for unset or unknown values", () => {
    const prev = process.env.LETTA_LISTENER_SURFACE;
    try {
      delete process.env.LETTA_LISTENER_SURFACE;
      expect(resolveListenerSurfaceFromEnv("server")).toBe("server");
      process.env.LETTA_LISTENER_SURFACE = "bogus-surface";
      expect(resolveListenerSurfaceFromEnv("listen")).toBe("listen");
    } finally {
      if (prev === undefined) {
        delete process.env.LETTA_LISTENER_SURFACE;
      } else {
        process.env.LETTA_LISTENER_SURFACE = prev;
      }
    }
  });

  it("desktop-remote and server slots differ for the same connection name", () => {
    expect(
      deriveListenerInstanceId("desktop-remote", "MacBook-Pro-8.local"),
    ).not.toBe(deriveListenerInstanceId("server", "MacBook-Pro-8.local"));
  });
});
