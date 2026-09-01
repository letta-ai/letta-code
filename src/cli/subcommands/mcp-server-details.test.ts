import { describe, expect, test } from "bun:test";
import type { UnifiedMcpClient } from "@/backend/api/unified-mcp";
import { type McpSubcommandDependencies, runMcpSubcommand } from "./mcp";

describe("MCP server details", () => {
  test("redacts HTTP headers and sensitive URL parameters", async () => {
    const stdout: string[] = [];
    const deps: McpSubcommandDependencies = {
      env: { AGENT_ID: "agent-local" },
      initializeSettings: async () => {},
      isServerMcpAvailable: () => false,
      getLocalServers: () => [
        {
          name: "private",
          transport: "http",
          url: "https://mcp.example.com/mcp?token=secret&tenant=letta",
          headers: { Authorization: "Bearer secret", "X-Tenant": "letta" },
        },
      ],
      stdout: (message) => stdout.push(message),
    };

    expect(await runMcpSubcommand(["get", "private"], deps)).toBe(0);
    expect(JSON.parse(stdout[0] ?? "{}")).toEqual({
      name: "private",
      transport: "streamable_http",
      url: "https://mcp.example.com/mcp?token=%5BREDACTED%5D&tenant=letta",
      headers: {
        Authorization: "[REDACTED]",
        "X-Tenant": "[REDACTED]",
      },
    });
  });

  test("enriches and redacts minimal cloud server associations", async () => {
    const serverPath = "/v1/agents/agent-cloud/mcp-servers";
    const client: UnifiedMcpClient = {
      get: async (path) =>
        path === serverPath ? [{ id: "mcp-exa", server_name: "Exa" }] : [],
      post: async () => ({}),
      mcpServers: {
        list: async () => [
          {
            id: "mcp-exa",
            server_name: "Exa",
            mcp_server_type: "streamable_http",
            server_url: "https://mcp.example.com/mcp?apiKey=secret",
          },
        ],
      },
    };
    const stdout: string[] = [];
    const deps: McpSubcommandDependencies = {
      env: { LETTA_AGENT_ID: "agent-cloud" },
      initializeSettings: async () => {},
      isServerMcpAvailable: () => true,
      getLocalServers: () => [],
      getClient: async () => client,
      stdout: (message) => stdout.push(message),
    };

    expect(await runMcpSubcommand(["list"], deps)).toBe(0);
    expect(JSON.parse(stdout[0] ?? "[]")).toEqual([
      { name: "Exa", transport: "streamable_http" },
    ]);
    expect(await runMcpSubcommand(["get", "Exa"], deps)).toBe(0);
    expect(JSON.parse(stdout[1] ?? "{}")).toEqual({
      name: "Exa",
      transport: "streamable_http",
      url: "https://mcp.example.com/mcp?apiKey=%5BREDACTED%5D",
      headers: {},
    });
  });

  test("lists, searches, and calls through minimal associations when enrichment fails", async () => {
    const serverPath = "/v1/agents/agent-cloud/mcp-servers";
    const toolsPath = `${serverPath}/mcp-exa/tools`;
    const searchPath = `${serverPath}/tools/search`;
    const runPath = `${toolsPath}/tool-echo/run`;
    const posts: string[] = [];
    const client: UnifiedMcpClient = {
      get: async (path) => {
        if (path === serverPath) return [{ id: "mcp-exa", server_name: "Exa" }];
        if (path === toolsPath) {
          return [
            {
              id: "tool-echo",
              name: "mcp__Exa__echo",
              json_schema: {
                parameters: { type: "object", properties: {} },
              },
            },
          ];
        }
        return [];
      },
      post: async (path) => {
        posts.push(path);
        if (path === searchPath) {
          return [
            {
              tool: {
                id: "tool-echo",
                json_schema: {
                  name: "mcp__Exa__echo",
                  parameters: { type: "object", properties: {} },
                },
              },
              combined_score: 0.5,
            },
          ];
        }
        if (path === runPath) {
          return { status: "success", func_return: "cloud echo" };
        }
        return {};
      },
      mcpServers: {
        list: async () => {
          throw new Error("catalog unavailable");
        },
      },
    };
    const stdout: string[] = [];
    const deps: McpSubcommandDependencies = {
      env: { LETTA_AGENT_ID: "agent-cloud" },
      initializeSettings: async () => {},
      isServerMcpAvailable: () => true,
      getLocalServers: () => [],
      getClient: async () => client,
      stdout: (message) => stdout.push(message),
    };

    expect(await runMcpSubcommand(["list"], deps)).toBe(0);
    expect(JSON.parse(stdout[0] ?? "[]")).toEqual([
      { name: "Exa", transport: "unknown" },
    ]);
    expect(await runMcpSubcommand(["search", "echo"], deps)).toBe(0);
    const toolName = JSON.parse(stdout[1] ?? "[]")[0]?.tool?.name;
    expect(toolName).toBe("mcp__Exa__echo");
    expect(await runMcpSubcommand(["call", toolName], deps)).toBe(0);
    expect(JSON.parse(stdout[2] ?? "{}")).toEqual({
      content: [{ type: "text", text: "cloud echo" }],
      isError: false,
    });
    expect(posts).toEqual([searchPath, runPath]);
  });
});
