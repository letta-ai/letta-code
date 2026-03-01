import { beforeEach, describe, expect, it, mock } from "bun:test";
import { registerWithCloud } from "../../websocket/listen-register";

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
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
});

describe("registerWithCloud", () => {
  it("returns connectionId and wsUrl on successful JSON response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ connectionId: "conn-1", wsUrl: "wss://example.com" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await registerWithCloud(defaultOpts);

    expect(result).toEqual({
      connectionId: "conn-1",
      wsUrl: "wss://example.com",
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
    expect(body).toEqual({
      deviceId: "device-123",
      connectionName: "test-machine",
    });
  });

  it("throws with body message on non-OK response with JSON error", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(registerWithCloud(defaultOpts)).rejects.toThrow(
      "Unauthorized",
    );
  });

  it("throws with HTTP status and truncated body on non-OK non-JSON response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("<html>Bad Gateway</html>", { status: 502 }),
    );

    await expect(registerWithCloud(defaultOpts)).rejects.toThrow(
      "HTTP 502: <html>Bad Gateway</html>",
    );
  });

  it("throws actionable message on 200 with non-JSON body", async () => {
    mockFetch.mockResolvedValueOnce(new Response("OK", { status: 200 }));

    await expect(registerWithCloud(defaultOpts)).rejects.toThrow(
      "is the server running?",
    );
  });

  it("throws on unexpected response shape (missing fields)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ connectionId: "conn-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(registerWithCloud(defaultOpts)).rejects.toThrow(
      "missing connectionId or wsUrl",
    );
  });
});
