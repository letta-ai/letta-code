import { describe, expect, mock, test } from "bun:test";
import type { Tool } from "@letta-ai/letta-client/resources/tools";
import type { ServerMcpClient } from "@/backend/api/mcp-servers";
import {
  type CloudMcpSubcommandDependencies,
  runCloudMcpSubcommand,
} from "@/cli/subcommands/cloud-mcp";

async function withEnv<T>(
  updates: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(updates)) {
    previous[key] = process.env[key];
    const next = updates[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }

  try {
    return await run();
  } finally {
    for (const key of Object.keys(updates)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function* emptyAgentTools(): AsyncIterable<Tool> {}

function createDeps(overrides: {
  getResponses?: Record<string, unknown>;
  postResponses?: Record<string, unknown>;
  postCalls?: string[];
  postBodies?: unknown[];
}): {
  stdout: string[];
  stderr: string[];
  deps: CloudMcpSubcommandDependencies;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const client: ServerMcpClient = {
    get: async (path) => overrides.getResponses?.[path] ?? [],
    post: async (path, body) => {
      overrides.postCalls?.push(path);
      overrides.postBodies?.push(body);
      return overrides.postResponses?.[path] ?? {};
    },
    mcpServers: {
      list: async () => [],
      refresh: async () => ({}),
    },
    agents: {
      tools: {
        list: () => emptyAgentTools(),
        attach: async () => ({}),
        detach: async () => ({}),
      },
    },
  };

  return {
    stdout,
    stderr,
    deps: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      initializeSettings: mock(() => Promise.resolve()),
      getClient: mock(() => Promise.resolve(client)),
      isServerSideMcpAvailable: () => true,
    },
  };
}

describe("cloud-mcp subcommand", () => {
  test("prints help", async () => {
    const { stdout, deps } = createDeps({});

    const exitCode = await runCloudMcpSubcommand(["--help"], deps);

    expect(exitCode).toBe(0);
    expect(stdout.join("\n")).toContain("letta cloud-mcp list");
    expect(stdout.join("\n")).toContain("letta cloud-mcp run");
  });

  test("requires an agent id", async () => {
    const { stderr, deps } = createDeps({});

    await withEnv(
      { LETTA_AGENT_ID: undefined, AGENT_ID: undefined },
      async () => {
        const exitCode = await runCloudMcpSubcommand(["list"], deps);

        expect(exitCode).toBe(1);
      },
    );

    expect(stderr.join("\n")).toContain("Agent id required");
  });

  test("lists servers connected to the current agent", async () => {
    const { stdout, deps } = createDeps({
      getResponses: {
        "/v1/agents/agent-1/mcp-servers": [
          {
            id: "mcp_server-1",
            server_name: "exa",
            mcp_server_type: "streamable_http",
            server_url: "https://mcp.example.com/mcp",
          },
        ],
      },
    });

    await withEnv({ LETTA_AGENT_ID: "agent-1" }, async () => {
      const exitCode = await runCloudMcpSubcommand(["list"], deps);

      expect(exitCode).toBe(0);
    });

    expect(stdout.join("\n")).toContain('"agent_id": "agent-1"');
    expect(stdout.join("\n")).toContain('"serverName": "exa"');
  });

  test("lists minimal server associations from the production API", async () => {
    const { stdout, deps } = createDeps({
      getResponses: {
        "/v1/agents/agent-1/mcp-servers": [
          { id: "mcp_server-1", server_name: "LaunchDarkly" },
        ],
      },
    });

    await withEnv({ LETTA_AGENT_ID: "agent-1" }, async () => {
      const exitCode = await runCloudMcpSubcommand(["list"], deps);

      expect(exitCode).toBe(0);
    });

    expect(stdout.join("\n")).toContain('"serverName": "LaunchDarkly"');
    expect(stdout.join("\n")).toContain('"serverType": "unknown"');
  });

  test("lists tools for a connected server", async () => {
    const { stdout, deps } = createDeps({
      getResponses: {
        "/v1/agents/agent-1/mcp-servers/mcp_server-1/tools": [
          { id: "tool-1", name: "search", description: "Search" },
        ],
      },
    });

    const exitCode = await runCloudMcpSubcommand(
      ["tools", "mcp_server-1", "--agent", "agent-1"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(stdout.join("\n")).toContain('"mcp_server_id": "mcp_server-1"');
    expect(stdout.join("\n")).toContain('"name": "search"');
  });

  test("runs a connected MCP tool with JSON args", async () => {
    const postCalls: string[] = [];
    const postBodies: unknown[] = [];
    const { stdout, deps } = createDeps({
      postCalls,
      postBodies,
      postResponses: {
        "/v1/agents/agent-1/mcp-servers/mcp_server-1/tools/tool-1/run": {
          status: "success",
          func_return: { answer: 42 },
        },
      },
    });

    const exitCode = await runCloudMcpSubcommand(
      [
        "run",
        "mcp_server-1",
        "tool-1",
        "--agent",
        "agent-1",
        "--args",
        '{"query":"letta"}',
      ],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(postCalls).toEqual([
      "/v1/agents/agent-1/mcp-servers/mcp_server-1/tools/tool-1/run",
    ]);
    expect(postBodies).toEqual([{ args: { query: "letta" } }]);
    expect(stdout.join("\n")).toContain('"answer": 42');
  });

  test("rejects non-object JSON args", async () => {
    const { stderr, deps } = createDeps({});

    const exitCode = await runCloudMcpSubcommand(
      ["run", "mcp_server-1", "tool-1", "--agent", "agent-1", "--args", "[]"],
      deps,
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("expected a JSON object");
  });
});
