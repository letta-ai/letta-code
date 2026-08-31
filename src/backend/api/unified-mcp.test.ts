import { describe, expect, test } from "bun:test";
import type { UnifiedMcpClient } from "./unified-mcp";
import {
  attachUnifiedMcpServer,
  detachUnifiedMcpServer,
  listUnifiedMcpServers,
  listUnifiedMcpTools,
  runUnifiedMcpTool,
} from "./unified-mcp";

function clientFixture(options: {
  get?: Record<string, unknown>;
  post?: Record<string, unknown>;
  puts?: string[];
  deletes?: string[];
  posts?: Array<{ path: string; body: unknown }>;
}): UnifiedMcpClient {
  return {
    get: async (path) => options.get?.[path] ?? [],
    post: async (path, request) => {
      options.posts?.push({ path, body: request?.body });
      return options.post?.[path] ?? {};
    },
    put: async (path) => {
      options.puts?.push(path);
      return {};
    },
    delete: async (path) => {
      options.deletes?.push(path);
      return {};
    },
    mcpServers: { list: async () => [] },
  };
}

describe("unified MCP API adapter", () => {
  test("parses rich server and tool records without changing legacy helpers", async () => {
    const serverPath = "/v1/agents/agent-1/mcp-servers";
    const toolsPath = `${serverPath}/mcp-1/tools`;
    const client = clientFixture({
      get: {
        [serverPath]: [
          {
            id: "mcp-1",
            server_name: "github",
            mcp_server_type: "streamable_http",
            server_url: "https://mcp.example.com/mcp",
          },
        ],
        [toolsPath]: [
          {
            id: "tool-1",
            name: "mcp__github__create_issue",
            title: "Create Issue",
            description: "Create an issue",
            json_schema: {
              parameters: {
                type: "object",
                properties: { title: { type: "string" } },
              },
            },
            annotations: { destructiveHint: false },
          },
        ],
      },
    });

    await expect(listUnifiedMcpServers(client, "agent-1")).resolves.toEqual([
      {
        id: "mcp-1",
        serverName: "github",
        serverType: "streamable_http",
        target: "https://mcp.example.com/mcp",
        serverUrl: "https://mcp.example.com/mcp",
      },
    ]);
    await expect(
      listUnifiedMcpTools(client, "agent-1", "mcp-1"),
    ).resolves.toEqual([
      {
        id: "tool-1",
        name: "mcp__github__create_issue",
        title: "Create Issue",
        description: "Create an issue",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
        },
        annotations: { destructiveHint: false },
      },
    ]);
  });

  test("uses SDK request options for run and association mutations", async () => {
    const puts: string[] = [];
    const deletes: string[] = [];
    const posts: Array<{ path: string; body: unknown }> = [];
    const runPath = "/v1/agents/agent-1/mcp-servers/mcp-1/tools/tool-1/run";
    const client = clientFixture({
      puts,
      deletes,
      posts,
      post: {
        [runPath]: { status: "success", func_return: "created" },
      },
    });

    await expect(
      runUnifiedMcpTool({
        client,
        agentId: "agent-1",
        mcpServerId: "mcp-1",
        toolId: "tool-1",
        args: { title: "Bug" },
      }),
    ).resolves.toEqual({
      status: "success",
      funcReturn: "created",
      stdout: undefined,
      stderr: undefined,
    });
    await attachUnifiedMcpServer(client, "agent-1", "mcp-1");
    await detachUnifiedMcpServer(client, "agent-1", "mcp-1");

    expect(posts).toEqual([
      { path: runPath, body: { args: { title: "Bug" } } },
    ]);
    expect(puts).toEqual(["/v1/agents/agent-1/mcp-servers/mcp-1"]);
    expect(deletes).toEqual(["/v1/agents/agent-1/mcp-servers/mcp-1"]);
  });
});
