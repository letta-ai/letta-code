import { describe, expect, test } from "bun:test";
import type { ConnectedMcpServer, McpServerConfig } from "@/mcp-client";
import { type McpSubcommandDependencies, runMcpSubcommand } from "./mcp";

const localServer: McpServerConfig = {
  name: "Mixed Server",
  transport: "stdio",
  command: "unused",
};

interface TestHarness {
  deps: McpSubcommandDependencies;
  stdout: string[];
  stderr: string[];
}

function harnessWithConnection(closes?: { count: number }): TestHarness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const connection: ConnectedMcpServer = {
    name: "Mixed Server",
    tools: [
      {
        name: "search/exact-name",
        title: "Search",
        description: "Search documents",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        outputSchema: {
          type: "object",
          properties: { results: { type: "array" } },
        },
        annotations: { readOnlyHint: true },
      },
    ],
    callTool: async () => ({ content: [] }),
    close: async () => {
      if (closes) closes.count++;
    },
  };
  return {
    stdout,
    stderr,
    deps: {
      env: { AGENT_ID: "agent-1" },
      initializeSettings: async () => {},
      isServerMcpAvailable: () => false,
      getLocalServers: () => [localServer],
      connectLocalServer: async () => connection,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

const fullSchema = {
  name: "mcp__Mixed_Server__search_exact-name",
  title: "Search",
  description: "Search documents",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  outputSchema: {
    type: "object",
    properties: { results: { type: "array" } },
  },
  annotations: { readOnlyHint: true },
};

describe("MCP tool listing", () => {
  test("tools lists name and description summaries and always closes", async () => {
    const closes = { count: 0 };
    const harness = harnessWithConnection(closes);
    expect(await runMcpSubcommand(["tools"], harness.deps)).toBe(0);
    expect(JSON.parse(harness.stdout[0] ?? "[]")).toEqual([
      {
        name: "mcp__Mixed_Server__search_exact-name",
        title: "Search",
        description: "Search documents",
      },
    ]);
    expect(closes.count).toBe(1);
  });

  test("tools --full returns bare generated schemas", async () => {
    const harness = harnessWithConnection();
    expect(await runMcpSubcommand(["tools", "--full"], harness.deps)).toBe(0);
    expect(JSON.parse(harness.stdout[0] ?? "[]")).toEqual([fullSchema]);
  });

  test("schema prints one complete tool schema and always closes", async () => {
    const closes = { count: 0 };
    const harness = harnessWithConnection(closes);
    expect(
      await runMcpSubcommand(
        ["schema", "mcp__Mixed_Server__search_exact-name"],
        harness.deps,
      ),
    ).toBe(0);
    expect(JSON.parse(harness.stdout[0] ?? "{}")).toEqual(fullSchema);
    expect(closes.count).toBe(1);
  });

  test("schema rejects unknown tool names", async () => {
    const harness = harnessWithConnection();
    expect(
      await runMcpSubcommand(
        ["schema", "mcp__Mixed_Server__missing"],
        harness.deps,
      ),
    ).toBe(1);
    expect(JSON.parse(harness.stderr[0] ?? "{}")).toEqual({
      error: {
        code: "tool_not_found",
        message: "MCP tool 'mcp__Mixed_Server__missing' is not available",
      },
    });
  });

  test("schema requires a tool name", async () => {
    const harness = harnessWithConnection();
    expect(await runMcpSubcommand(["schema"], harness.deps)).toBe(1);
    expect(JSON.parse(harness.stderr[0] ?? "{}")).toEqual({
      error: {
        code: "invalid_arguments",
        message: "Usage: letta mcp schema <tool-name>",
      },
    });
  });
});
