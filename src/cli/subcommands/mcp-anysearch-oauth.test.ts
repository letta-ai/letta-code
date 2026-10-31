import { describe, expect, test } from "bun:test";
import type { ConnectedMcpServer, McpServerConfig } from "@/mcp-client";
import { resolveMcpPreset } from "@/mcp-presets";
import { type McpSubcommandDependencies, runMcpSubcommand } from "./mcp";

interface TestHarness {
  deps: McpSubcommandDependencies;
  stdout: string[];
  stderr: string[];
}

function localHarness(servers: McpServerConfig[]): TestHarness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      env: { AGENT_ID: "agent-1" },
      initializeSettings: async () => {},
      isServerMcpAvailable: () => false,
      getLocalServers: () => servers,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

function fakeConnection(): ConnectedMcpServer {
  return {
    name: "AnySearch",
    tools: [
      {
        name: "search",
        description: "General web search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: async () => {},
  };
}

describe("AnySearch preset never enters OAuth (headless /letta mcp path)", () => {
  test("anonymous preset never requests an OAuth session", async () => {
    const oauthRequests: unknown[] = [];
    const connectorOAuth: unknown[] = [];
    const preset = resolveMcpPreset("anysearch", {});
    if (!preset) throw new Error("expected anysearch preset to resolve");

    const harness = localHarness([preset]);
    harness.deps.createOAuthSession = async (...args) => {
      oauthRequests.push(args);
      return { authProvider: {} as never, close: async () => {} };
    };
    harness.deps.connectLocalServer = async (_config, options) => {
      connectorOAuth.push(options?.oauth);
      return fakeConnection();
    };

    expect(await runMcpSubcommand(["tools", "anysearch"], harness.deps)).toBe(
      0,
    );
    expect(oauthRequests).toEqual([]);
    expect(connectorOAuth).toEqual([undefined]);
  });

  test("authenticated preset (Authorization header set) never requests an OAuth session", async () => {
    const oauthRequests: unknown[] = [];
    const connectorOAuth: unknown[] = [];
    const preset = resolveMcpPreset("anysearch", {
      ANYSEARCH_API_KEY: "sk-should-not-trigger-oauth",
    });
    if (!preset) throw new Error("expected anysearch preset to resolve");

    const harness = localHarness([preset]);
    harness.deps.createOAuthSession = async (...args) => {
      oauthRequests.push(args);
      return { authProvider: {} as never, close: async () => {} };
    };
    harness.deps.connectLocalServer = async (_config, options) => {
      connectorOAuth.push(options?.oauth);
      return fakeConnection();
    };

    expect(await runMcpSubcommand(["tools", "anysearch"], harness.deps)).toBe(
      0,
    );
    expect(oauthRequests).toEqual([]);
    expect(connectorOAuth).toEqual([undefined]);
  });

  test("a persisted (settings round-tripped) config still skips OAuth", async () => {
    const oauthRequests: unknown[] = [];
    const preset = resolveMcpPreset("anysearch", {});
    if (!preset) throw new Error("expected anysearch preset to resolve");
    const persisted: McpServerConfig = JSON.parse(JSON.stringify(preset));

    const harness = localHarness([persisted]);
    harness.deps.createOAuthSession = async (...args) => {
      oauthRequests.push(args);
      return { authProvider: {} as never, close: async () => {} };
    };
    harness.deps.connectLocalServer = async () => fakeConnection();

    expect(await runMcpSubcommand(["tools", "anysearch"], harness.deps)).toBe(
      0,
    );
    expect(oauthRequests).toEqual([]);
  });
});
