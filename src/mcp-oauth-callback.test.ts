import { describe, expect, test } from "bun:test";
import { startOAuthCallbackServer } from "./mcp-oauth-callback";

async function deliver(
  query: Record<string, string>,
): Promise<{ status: number; result: unknown }> {
  const server = await startOAuthCallbackServer();
  server.expectedState.value = "state-1";
  try {
    const url = new URL(server.redirectUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url);
    await response.text();
    return { status: response.status, result: await server.waitForCallback() };
  } finally {
    server.close();
  }
}

describe("MCP OAuth callback server", () => {
  test("returns the provider's domain alongside the code", async () => {
    expect(
      await deliver({
        code: "code-1",
        domain: "us5.datadoghq.com",
        state: "state-1",
      }),
    ).toEqual({
      status: 200,
      result: { code: "code-1", domain: "us5.datadoghq.com" },
    });
  });

  test("omits domain when the provider does not send one", async () => {
    expect(await deliver({ code: "code-1", state: "state-1" })).toEqual({
      status: 200,
      result: { code: "code-1" },
    });
  });

  test("ignores callbacks with a mismatched state", async () => {
    const server = await startOAuthCallbackServer();
    server.expectedState.value = "state-1";
    const waiting = server.waitForCallback();
    try {
      const url = new URL(server.redirectUrl);
      url.searchParams.set("code", "code-1");
      url.searchParams.set("domain", "us5.datadoghq.com");
      url.searchParams.set("state", "other");
      const response = await fetch(url);
      await response.text();
      expect(response.status).toBe(400);
    } finally {
      server.close();
    }
    await expect(waiting).rejects.toThrow("MCP OAuth flow was cancelled");
  });
});
