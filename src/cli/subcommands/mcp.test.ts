import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { Tool } from "@letta-ai/letta-client/resources/tools";
import type { ServerMcpClient } from "@/backend/api/mcp-servers";
import type {
  ConnectedMcpServer,
  McpServerConfig,
  McpToolResult,
} from "@/mcp-client";
import { type McpSubcommandDependencies, runMcpSubcommand } from "./mcp";

const EVERYTHING_SERVER = fileURLToPath(
  new URL(
    "./dist/index.js",
    import.meta.resolve("@modelcontextprotocol/server-everything/package.json"),
  ),
);

interface TestHarness {
  deps: McpSubcommandDependencies;
  stdout: string[];
  stderr: string[];
  saved: McpServerConfig[][];
  flushes: { count: number };
}

interface CloudHarness {
  deps: McpSubcommandDependencies;
  stdout: string[];
  stderr: string[];
  puts: string[];
  deletes: string[];
  posts: Array<{ path: string; body: unknown }>;
}

function localHarness(
  options: {
    servers?: McpServerConfig[];
    connection?: ConnectedMcpServer;
    connectError?: Error;
  } = {},
): TestHarness {
  let servers = options.servers ?? [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const saved: McpServerConfig[][] = [];
  const flushes = { count: 0 };
  return {
    stdout,
    stderr,
    saved,
    flushes,
    deps: {
      env: { AGENT_ID: "agent-1" },
      initializeSettings: async () => {},
      isServerMcpAvailable: () => false,
      getLocalServers: () => servers,
      setLocalServers: (_agentId, value) => {
        servers = value;
        saved.push(value);
      },
      flushSettings: async () => {
        flushes.count++;
      },
      connectLocalServer: async () => {
        if (options.connectError) throw options.connectError;
        if (!options.connection) throw new Error("Unexpected MCP connection");
        return options.connection;
      },
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

function fakeConnection(
  options: {
    result?: McpToolResult;
    calls?: Array<{ name: string; args: Record<string, unknown> }>;
    closes?: { count: number };
  } = {},
): ConnectedMcpServer {
  return {
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
    callTool: async (name, args = {}) => {
      options.calls?.push({ name, args });
      return (
        options.result ?? {
          content: [{ type: "text", text: "ok" }],
          structuredContent: { answer: 42 },
        }
      );
    },
    close: async () => {
      if (options.closes) options.closes.count++;
    },
  };
}

function emptyTools(): AsyncIterable<Tool> {
  return (async function* () {})();
}

function cloudHarness(
  options: {
    getResponses?: Record<string, unknown>;
    postResponses?: Record<string, unknown>;
    globalServers?: Array<Record<string, unknown>>;
  } = {},
): CloudHarness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const puts: string[] = [];
  const deletes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  const client: ServerMcpClient = {
    get: async (path) => options.getResponses?.[path] ?? [],
    post: async (path, request) => {
      posts.push({ path, body: request?.body });
      return options.postResponses?.[path] ?? {};
    },
    put: async (path) => {
      puts.push(path);
      return {};
    },
    delete: async (path) => {
      deletes.push(path);
      return {};
    },
    mcpServers: {
      list: async () => (options.globalServers ?? []) as never[],
      refresh: async () => ({}),
    },
    agents: {
      tools: {
        list: () => emptyTools(),
        attach: async () => ({}),
        detach: async () => ({}),
      },
    },
  };
  return {
    stdout,
    stderr,
    puts,
    deletes,
    posts,
    deps: {
      env: { LETTA_AGENT_ID: "agent-cloud" },
      initializeSettings: async () => {},
      isServerMcpAvailable: () => true,
      getLocalServers: () => [],
      getClient: async () => client,
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    } satisfies McpSubcommandDependencies,
  };
}

const localServer: McpServerConfig = {
  name: "Mixed Server",
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  cwd: "/workspace",
  env: { MCP_TOKEN: "secret" },
};

describe("mcp subcommand", () => {
  test("prints help without requiring agent context", async () => {
    const output: string[] = [];
    expect(
      await runMcpSubcommand(["--help"], {
        env: {},
        stdout: (message) => output.push(message),
      }),
    ).toBe(0);
    expect(output[0]).toContain("letta mcp tools");
    expect(output[0]).toContain("letta mcp call");
  });

  test("returns a structured agent requirement error", async () => {
    const stderr: string[] = [];
    expect(
      await runMcpSubcommand(["list"], {
        env: {},
        stderr: (message) => stderr.push(message),
      }),
    ).toBe(1);
    expect(JSON.parse(stderr[0] ?? "{}")).toEqual({
      error: {
        code: "agent_id_required",
        message: "No agent context found",
        hint: "Pass --agent <agent-id> or set LETTA_AGENT_ID.",
      },
    });
  });

  test("lists and gets redacted server configuration without connecting", async () => {
    const harness = localHarness({ servers: [localServer] });
    expect(await runMcpSubcommand(["list"], harness.deps)).toBe(0);
    expect(JSON.parse(harness.stdout[0] ?? "[]")).toEqual([
      { name: "Mixed Server", transport: "stdio" },
    ]);

    expect(await runMcpSubcommand(["get", "Mixed Server"], harness.deps)).toBe(
      0,
    );
    expect(JSON.parse(harness.stdout[1] ?? "{}")).toEqual({
      name: "Mixed Server",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      cwd: "/workspace",
      env: { MCP_TOKEN: "[REDACTED]" },
    });
  });

  test("redacts HTTP headers and sensitive URL parameters", async () => {
    const harness = localHarness({
      servers: [
        {
          name: "private",
          transport: "http",
          url: "https://mcp.example.com/mcp?token=secret&tenant=letta",
          headers: { Authorization: "Bearer secret", "X-Tenant": "letta" },
        },
      ],
    });
    expect(await runMcpSubcommand(["get", "private"], harness.deps)).toBe(0);
    expect(JSON.parse(harness.stdout[0] ?? "{}")).toEqual({
      name: "private",
      transport: "streamable_http",
      url: "https://mcp.example.com/mcp?token=%5BREDACTED%5D&tenant=letta",
      headers: {
        Authorization: "[REDACTED]",
        "X-Tenant": "[REDACTED]",
      },
    });
  });

  test("verifies a local add before persisting it", async () => {
    const closes = { count: 0 };
    const harness = localHarness({ connection: fakeConnection({ closes }) });
    expect(
      await runMcpSubcommand(
        [
          "add",
          "files",
          "--transport",
          "stdio",
          "--cwd",
          "/repo",
          "--",
          "npx",
          "-y",
          "server-filesystem",
          ".",
        ],
        harness.deps,
      ),
    ).toBe(0);
    expect(harness.saved).toEqual([
      [
        {
          name: "files",
          transport: "stdio",
          command: "npx",
          args: ["-y", "server-filesystem", "."],
          cwd: "/repo",
        },
      ],
    ]);
    expect(harness.flushes.count).toBe(1);
    expect(closes.count).toBe(1);
  });

  test("does not persist a local add that cannot connect", async () => {
    const harness = localHarness({
      connectError: new Error("connection failed"),
    });
    expect(
      await runMcpSubcommand(
        ["add", "broken", "--transport", "stdio", "--", "missing"],
        harness.deps,
      ),
    ).toBe(1);
    expect(harness.saved).toEqual([]);
    expect(harness.flushes.count).toBe(0);
  });

  test("logs in and out with the selected local server's OAuth identity", async () => {
    const closes = { count: 0 };
    const clears: Array<{ agentId: string; name: string; url: string }> = [];
    const harness = localHarness({
      servers: [
        {
          name: "notion",
          transport: "http",
          url: "https://mcp.notion.example/mcp",
        },
      ],
      connection: fakeConnection({ closes }),
    });
    harness.deps.createOAuthSession = async () => ({
      authProvider: {} as never,
      close: async () => {},
    });
    harness.deps.clearOAuthCredentials = async (agentId, name, url) => {
      clears.push({ agentId, name, url });
      return true;
    };

    expect(
      await runMcpSubcommand(["login", "notion", "--force"], harness.deps),
    ).toBe(0);
    expect(JSON.parse(harness.stdout[0] ?? "{}")).toEqual({
      ok: true,
      name: "notion",
      status: "authenticated",
    });
    expect(closes.count).toBe(1);

    expect(await runMcpSubcommand(["logout", "notion"], harness.deps)).toBe(0);
    expect(JSON.parse(harness.stdout[1] ?? "{}")).toEqual({
      ok: true,
      name: "notion",
      status: "logged_out",
    });
    expect(clears).toEqual([
      {
        agentId: "agent-1",
        name: "notion",
        url: "https://mcp.notion.example/mcp",
      },
      {
        agentId: "agent-1",
        name: "notion",
        url: "https://mcp.notion.example/mcp",
      },
    ]);
  });

  test("removes local configuration and its OAuth credentials", async () => {
    const clears: string[] = [];
    const harness = localHarness({
      servers: [
        {
          name: "notion",
          transport: "http",
          url: "https://mcp.notion.example/mcp",
        },
      ],
    });
    harness.deps.clearOAuthCredentials = async (_agentId, name) => {
      clears.push(name);
      return true;
    };

    expect(await runMcpSubcommand(["remove", "notion"], harness.deps)).toBe(0);
    expect(harness.saved).toEqual([[]]);
    expect(harness.flushes.count).toBe(1);
    expect(clears).toEqual(["notion"]);
  });

  test("tools returns bare generated schemas and always closes", async () => {
    const closes = { count: 0 };
    const harness = localHarness({
      servers: [localServer],
      connection: fakeConnection({ closes }),
    });
    expect(await runMcpSubcommand(["tools"], harness.deps)).toBe(0);
    expect(JSON.parse(harness.stdout[0] ?? "[]")).toEqual([
      {
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
      },
    ]);
    expect(closes.count).toBe(1);
  });

  test("call accepts the exact listed name and returns the bare MCP result", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const closes = { count: 0 };
    const harness = localHarness({
      servers: [localServer],
      connection: fakeConnection({ calls, closes }),
    });
    expect(
      await runMcpSubcommand(
        [
          "call",
          "mcp__Mixed_Server__search_exact-name",
          "--args",
          '{"query":"memory"}',
        ],
        harness.deps,
      ),
    ).toBe(0);
    expect(calls).toEqual([
      { name: "search/exact-name", args: { query: "memory" } },
    ]);
    expect(JSON.parse(harness.stdout[0] ?? "{}")).toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { answer: 42 },
    });
    expect(closes.count).toBe(1);
  });

  test("calls a real stdio MCP server through the generated tool name", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps: McpSubcommandDependencies = {
      env: { AGENT_ID: "agent-1" },
      initializeSettings: async () => {},
      isServerMcpAvailable: () => false,
      getLocalServers: () => [
        {
          name: "everything",
          transport: "stdio",
          command: process.execPath,
          args: [EVERYTHING_SERVER],
        },
      ],
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    };

    expect(
      await runMcpSubcommand(
        [
          "call",
          "mcp__everything__echo",
          "--args",
          '{"message":"hello from CLI"}',
        ],
        deps,
      ),
    ).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0] ?? "{}")).toEqual({
      content: [{ type: "text", text: "Echo: hello from CLI" }],
    });
  }, 20_000);

  test("prints MCP protocol errors and returns exit code 2", async () => {
    const harness = localHarness({
      servers: [localServer],
      connection: fakeConnection({
        result: {
          content: [{ type: "text", text: "invalid query" }],
          isError: true,
        },
      }),
    });
    expect(
      await runMcpSubcommand(
        ["call", "mcp__Mixed_Server__search_exact-name"],
        harness.deps,
      ),
    ).toBe(2);
    expect(JSON.parse(harness.stdout[0] ?? "{}").isError).toBe(true);
  });

  test("unifies cloud tools and calls without exposing route metadata", async () => {
    const serverPath = "/v1/agents/agent-cloud/mcp-servers";
    const toolsPath = `${serverPath}/mcp-1/tools`;
    const runPath = `${toolsPath}/tool-1/run`;
    const harness = cloudHarness({
      getResponses: {
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
            outputSchema: {
              type: "object",
              properties: { issue_number: { type: "number" } },
            },
            annotations: { destructiveHint: false },
            json_schema: {
              parameters: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            },
          },
        ],
      },
      postResponses: {
        [runPath]: {
          status: "success",
          func_return: "Created issue #123",
          stdout: [],
          stderr: [],
        },
      },
    });

    expect(await runMcpSubcommand(["tools"], harness.deps)).toBe(0);
    expect(JSON.parse(harness.stdout[0] ?? "[]")).toEqual([
      {
        name: "mcp__github__create_issue",
        title: "Create Issue",
        description: "Create an issue",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
        outputSchema: {
          type: "object",
          properties: { issue_number: { type: "number" } },
        },
        annotations: { destructiveHint: false },
      },
    ]);

    expect(
      await runMcpSubcommand(
        ["call", "mcp__github__create_issue", "--args", '{"title":"Bug"}'],
        harness.deps,
      ),
    ).toBe(0);
    expect(JSON.parse(harness.stdout[1] ?? "{}")).toEqual({
      content: [{ type: "text", text: "Created issue #123" }],
      isError: false,
    });
    expect(harness.posts).toEqual([
      { path: runPath, body: { args: { title: "Bug" } } },
    ]);
  });

  test("keeps scoped tool names callable when another server collides", async () => {
    const serverPath = "/v1/agents/agent-cloud/mcp-servers";
    const toolsPath = `${serverPath}/mcp-1/tools`;
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const harness = cloudHarness({
      getResponses: {
        [serverPath]: [
          {
            id: "mcp-1",
            server_name: "foo_bar",
            mcp_server_type: "streamable_http",
            server_url: "https://mcp.example.com/mcp",
          },
        ],
        [toolsPath]: [
          {
            id: "tool-1",
            name: "mcp__foo_bar__search",
            json_schema: { parameters: { type: "object", properties: {} } },
          },
        ],
      },
    });
    harness.deps.getLocalServers = () => [
      {
        name: "foo bar",
        transport: "stdio",
        command: "fixture",
      },
    ];
    harness.deps.connectLocalServer = async () => ({
      name: "foo bar",
      tools: [
        {
          name: "search",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      callTool: async (name, args = {}) => {
        calls.push({ name, args });
        return { content: [{ type: "text", text: "local" }] };
      },
      close: async () => {},
    });

    expect(await runMcpSubcommand(["tools", "foo bar"], harness.deps)).toBe(0);
    expect(JSON.parse(harness.stdout[0] ?? "[]")[0].name).toBe(
      "mcp__foo_bar__search_2",
    );
    expect(
      await runMcpSubcommand(["call", "mcp__foo_bar__search_2"], harness.deps),
    ).toBe(0);
    expect(calls).toEqual([{ name: "search", args: {} }]);
  });

  test("suffixes duplicate server-side tool names instead of failing", async () => {
    const serverPath = "/v1/agents/agent-cloud/mcp-servers";
    const toolsPath = `${serverPath}/mcp-1/tools`;
    const harness = cloudHarness({
      getResponses: {
        [serverPath]: [
          {
            id: "mcp-1",
            server_name: "duplicate",
            mcp_server_type: "streamable_http",
            server_url: "https://mcp.example.com/mcp",
          },
        ],
        [toolsPath]: [
          { id: "tool-1", name: "mcp__duplicate__search" },
          { id: "tool-2", name: "mcp__duplicate__search" },
        ],
      },
    });

    expect(await runMcpSubcommand(["tools"], harness.deps)).toBe(0);
    expect(
      JSON.parse(harness.stdout[0] ?? "[]").map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual(["mcp__duplicate__search", "mcp__duplicate__search_2"]);
  });

  test("adds and removes an existing cloud server through hidden ids", async () => {
    const serverPath = "/v1/agents/agent-cloud/mcp-servers";
    const toolsPath = `${serverPath}/mcp-1/tools`;
    const harness = cloudHarness({
      globalServers: [
        {
          id: "mcp-1",
          server_name: "github",
          mcp_server_type: "streamable_http",
          server_url: "https://mcp.example.com/mcp",
        },
      ],
      getResponses: {
        [toolsPath]: [],
        [serverPath]: [
          {
            id: "mcp-1",
            server_name: "github",
            mcp_server_type: "streamable_http",
            server_url: "https://mcp.example.com/mcp",
          },
        ],
      },
    });
    expect(await runMcpSubcommand(["add", "github"], harness.deps)).toBe(0);
    expect(harness.puts).toEqual([`${serverPath}/mcp-1`]);
    expect(JSON.parse(harness.stdout[0] ?? "{}")).toEqual({
      ok: true,
      server: { name: "github", transport: "streamable_http" },
      toolCount: 0,
    });

    expect(await runMcpSubcommand(["remove", "github"], harness.deps)).toBe(0);
    expect(harness.deletes).toEqual([`${serverPath}/mcp-1`]);
  });
});
