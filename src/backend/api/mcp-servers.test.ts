import { describe, expect, test } from "bun:test";
import type { Tool } from "@letta-ai/letta-client/resources/tools";
import {
  type AgentMcpAttachment,
  attachedToolNamesForEntry,
  attachmentsForEntry,
  attachServerMcpTools,
  describeServerMcpTarget,
  detachServerMcpTools,
  listAgentMcpAttachments,
  listLiveServerMcpTools,
  listServerMcpServers,
  loadServerMcpEntries,
  planServerMcpToggle,
  registerServerMcpTool,
  type ServerMcpClient,
  type ServerMcpEntry,
  type ServerMcpServer,
} from "./mcp-servers";

function httpServer(overrides: Partial<ServerMcpServer> = {}): ServerMcpServer {
  return {
    id: "mcp_server-1",
    server_name: "exa",
    server_url: "https://mcp.example.com/mcp",
    mcp_server_type: "streamable_http",
    ...overrides,
  } as ServerMcpServer;
}

function entry(
  toolNames: string[],
  overrides: Partial<ServerMcpEntry> = {},
): ServerMcpEntry {
  return {
    server: httpServer(),
    tools: toolNames.map((name) => ({ name })),
    ...overrides,
  };
}

function attachment(
  toolId: string,
  toolName: string,
  overrides: Partial<AgentMcpAttachment> = {},
): AgentMcpAttachment {
  return { toolId, toolName, serverId: "mcp_server-1", ...overrides };
}

function stubClient(overrides: {
  servers?: ServerMcpServer[];
  getResponses?: Record<string, unknown>;
  postResponses?: Record<string, unknown>;
  agentTools?: Tool[];
  attachCalls?: Array<{ toolId: string; agentId: string }>;
  detachCalls?: Array<{ toolId: string; agentId: string }>;
  postCalls?: string[];
}): ServerMcpClient {
  return {
    get: async (path: string) => overrides.getResponses?.[path] ?? [],
    post: async (path: string) => {
      overrides.postCalls?.push(path);
      return overrides.postResponses?.[path] ?? {};
    },
    mcpServers: {
      list: async () => overrides.servers ?? [],
      refresh: async () => ({}),
    },
    agents: {
      tools: {
        list: (_agentId: string) => {
          const items = overrides.agentTools ?? [];
          return (async function* () {
            yield* items;
          })();
        },
        attach: async (toolId: string, params: { agent_id: string }) => {
          overrides.attachCalls?.push({ toolId, agentId: params.agent_id });
          return {};
        },
        detach: async (toolId: string, params: { agent_id: string }) => {
          overrides.detachCalls?.push({ toolId, agentId: params.agent_id });
          return {};
        },
      },
    },
  };
}

describe("planServerMcpToggle", () => {
  test("attaches every tool by name when none are attached", () => {
    const plan = planServerMcpToggle(entry(["t1", "t2"]), []);
    expect(plan).toEqual({ action: "attach", toolNames: ["t1", "t2"] });
  });

  test("detaches only this server's attachments when any exist", () => {
    const plan = planServerMcpToggle(entry(["t1", "t2"]), [
      attachment("tool-a", "t1"),
      attachment("tool-b", "other", { serverId: "mcp_server-2" }),
    ]);
    expect(plan).toEqual({ action: "detach", toolIds: ["tool-a"] });
  });
});

describe("attachmentsForEntry", () => {
  test("matches by server id when both sides have one", () => {
    const matched = attachmentsForEntry(entry(["t1"]), [
      attachment("tool-a", "t1"),
      attachment("tool-b", "t1", { serverId: "mcp_server-2" }),
    ]);
    expect(matched.map((a) => a.toolId)).toEqual(["tool-a"]);
  });

  test("falls back to server name when the attachment has no server id", () => {
    const matched = attachmentsForEntry(entry(["t1"]), [
      { toolId: "tool-a", toolName: "t1", serverName: "exa" },
      { toolId: "tool-b", toolName: "t1", serverName: "other" },
    ]);
    expect(matched.map((a) => a.toolId)).toEqual(["tool-a"]);
  });
});

describe("attachedToolNamesForEntry", () => {
  test("returns the attached tool names for the entry's server", () => {
    const names = attachedToolNamesForEntry(entry(["t1", "t2"]), [
      attachment("tool-a", "t1"),
    ]);
    expect([...names]).toEqual(["t1"]);
  });
});

describe("describeServerMcpTarget", () => {
  test("uses server_url for remote servers", () => {
    expect(describeServerMcpTarget(httpServer())).toBe(
      "https://mcp.example.com/mcp",
    );
  });

  test("joins command and args for stdio servers", () => {
    const stdio = {
      id: "mcp_server-2",
      server_name: "fs",
      command: "npx",
      args: ["-y", "server-filesystem"],
      mcp_server_type: "stdio",
    } as ServerMcpServer;
    expect(describeServerMcpTarget(stdio)).toBe("npx -y server-filesystem");
  });
});

describe("listLiveServerMcpTools", () => {
  test("fetches tools from the name-keyed legacy route", async () => {
    const client = stubClient({
      getResponses: {
        "/v1/tools/mcp/servers/exa/tools": [
          { name: "web_search_exa", description: "search" },
          { notATool: true },
        ],
      },
    });
    const tools = await listLiveServerMcpTools(client, "exa");
    expect(tools).toEqual([{ name: "web_search_exa", description: "search" }]);
  });
});

describe("loadServerMcpEntries", () => {
  test("pairs each server with its live tools", async () => {
    const client = stubClient({
      servers: [httpServer()],
      getResponses: {
        "/v1/tools/mcp/servers/exa/tools": [{ name: "t1" }],
      },
    });
    const entries = await loadServerMcpEntries(client);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tools.map((t) => t.name)).toEqual(["t1"]);
    expect(entries[0]?.toolsError).toBeUndefined();
  });

  test("captures per-server tool listing failures", async () => {
    const client = stubClient({
      servers: [httpServer(), httpServer({ server_name: "broken" })],
      getResponses: {
        "/v1/tools/mcp/servers/exa/tools": [{ name: "t1" }],
      },
    });
    client.get = async (path: string) => {
      if (path.includes("broken")) throw new Error("boom");
      return [{ name: "t1" }];
    };
    const entries = await loadServerMcpEntries(client);
    expect(entries[0]?.toolsError).toBeUndefined();
    expect(entries[1]?.tools).toEqual([]);
    expect(entries[1]?.toolsError).toBe("boom");
  });
});

describe("listServerMcpServers", () => {
  test("rejects when the request exceeds the timeout", async () => {
    const client = stubClient({});
    client.mcpServers.list = () => new Promise(() => {});
    await expect(listServerMcpServers(client, 10)).rejects.toThrow(/timed out/);
  });
});

describe("listAgentMcpAttachments", () => {
  test("keeps only external_mcp tools and parses their metadata", async () => {
    const client = stubClient({
      agentTools: [
        {
          id: "tool-a",
          name: "web_search_exa",
          tool_type: "external_mcp",
          metadata_: {
            mcp: { server_id: "mcp_server-1", server_name: "exa" },
          },
        } as unknown as Tool,
        { id: "tool-b", name: "shell", tool_type: "custom" } as unknown as Tool,
      ],
    });
    const attachments = await listAgentMcpAttachments(client, "agent-1");
    expect(attachments).toEqual([
      {
        toolId: "tool-a",
        toolName: "web_search_exa",
        serverId: "mcp_server-1",
        serverName: "exa",
      },
    ]);
  });
});

describe("registerServerMcpTool", () => {
  test("posts to the name-keyed register route and returns the tool id", async () => {
    const postCalls: string[] = [];
    const client = stubClient({
      postCalls,
      postResponses: {
        "/v1/tools/mcp/servers/exa/web_search_exa": { id: "tool-a" },
      },
    });
    const result = await registerServerMcpTool(client, "exa", "web_search_exa");
    expect(result).toEqual({ id: "tool-a" });
    expect(postCalls).toEqual(["/v1/tools/mcp/servers/exa/web_search_exa"]);
  });

  test("throws when registration returns no id", async () => {
    const client = stubClient({});
    await expect(registerServerMcpTool(client, "exa", "t1")).rejects.toThrow(
      /returned no tool id/,
    );
  });
});

describe("attachServerMcpTools", () => {
  test("registers each tool then attaches the returned id", async () => {
    const attachCalls: Array<{ toolId: string; agentId: string }> = [];
    const client = stubClient({
      attachCalls,
      postResponses: {
        "/v1/tools/mcp/servers/exa/t1": { id: "tool-a" },
        "/v1/tools/mcp/servers/exa/t2": { id: "tool-b" },
      },
    });
    await attachServerMcpTools(client, "agent-1", "exa", ["t1", "t2"]);
    expect(
      attachCalls.sort((a, b) => a.toolId.localeCompare(b.toolId)),
    ).toEqual([
      { toolId: "tool-a", agentId: "agent-1" },
      { toolId: "tool-b", agentId: "agent-1" },
    ]);
  });
});

describe("detachServerMcpTools", () => {
  test("detaches each tool from the agent", async () => {
    const detachCalls: Array<{ toolId: string; agentId: string }> = [];
    const client = stubClient({ detachCalls });
    await detachServerMcpTools(client, "agent-1", ["tool-a"]);
    expect(detachCalls).toEqual([{ toolId: "tool-a", agentId: "agent-1" }]);
  });
});
