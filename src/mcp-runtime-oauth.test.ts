import { afterEach, describe, expect, mock, test } from "bun:test";
import type { McpServerConfig } from "@/mcp-client";
import { ANYSEARCH_API_KEY_ENV, resolveMcpPreset } from "@/mcp-presets";

const oauthCalls: Array<{ agentId: string; name: string; url: string }> = [];
const fakeSession = { authProvider: {} as never, close: async () => {} };

mock.module("@/mcp-oauth", () => ({
  createMcpOAuthSession: async (agentId: string, name: string, url: string) => {
    oauthCalls.push({ agentId, name, url });
    return fakeSession;
  },
}));

const { oauthSessionForConfig } = await import("./mcp-runtime");

afterEach(() => {
  oauthCalls.length = 0;
  mock.restore();
});

describe("oauthSessionForConfig (client-local /mcp add OAuth gate)", () => {
  test("default behavior is unchanged: a header-less http server still gets an OAuth session", async () => {
    const config: McpServerConfig = {
      name: "notion",
      transport: "http",
      url: "https://mcp.notion.example/mcp",
    };

    const session = await oauthSessionForConfig("agent-1", config, {});

    expect(session).toBe(fakeSession);
    expect(oauthCalls).toEqual([
      {
        agentId: "agent-1",
        name: "notion",
        url: "https://mcp.notion.example/mcp",
      },
    ]);
  });

  test("AnySearch anonymous config never creates an OAuth session", async () => {
    const config = resolveMcpPreset("anysearch", {});
    if (!config) throw new Error("expected anysearch preset to resolve");

    const session = await oauthSessionForConfig("agent-1", config, {});

    expect(session).toBeUndefined();
    expect(oauthCalls).toEqual([]);
  });

  test("AnySearch authenticated config never creates an OAuth session", async () => {
    const config = resolveMcpPreset("anysearch", {
      ANYSEARCH_API_KEY: "sk-should-not-trigger-oauth",
    });
    if (!config) throw new Error("expected anysearch preset to resolve");

    expect(config.headers?.Authorization).toBe(
      `Bearer \${${ANYSEARCH_API_KEY_ENV}}`,
    );

    const session = await oauthSessionForConfig("agent-1", config, {});

    expect(session).toBeUndefined();
    expect(oauthCalls).toEqual([]);
  });

  test("a persisted (settings round-tripped) AnySearch config retains the OAuth opt-out", async () => {
    const original = resolveMcpPreset("anysearch", {});
    if (!original) throw new Error("expected anysearch preset to resolve");

    // Simulate settingsManager persisting this config to disk and reloading
    // it — plain JSON, no schema that could drop the `oauth` field.
    const persisted: McpServerConfig = JSON.parse(JSON.stringify(original));

    expect(persisted.transport === "http" && persisted.oauth).toBe(false);

    const session = await oauthSessionForConfig("agent-1", persisted, {});

    expect(session).toBeUndefined();
    expect(oauthCalls).toEqual([]);
  });

  test("explicit oauth:false opts any http server out, independent of headers", async () => {
    const config: McpServerConfig = {
      name: "custom",
      transport: "http",
      url: "https://mcp.example.com/mcp",
      oauth: false,
    };

    const session = await oauthSessionForConfig("agent-1", config, {});

    expect(session).toBeUndefined();
    expect(oauthCalls).toEqual([]);
  });
});
