import { describe, expect, test } from "bun:test";
import type { UnifiedMcpClient } from "@/backend/api/unified-mcp";
import { type McpSubcommandDependencies, runMcpSubcommand } from "./mcp";

const serverPath = "/v1/agents/agent-cloud/mcp-servers";
const searchPath = `${serverPath}/tools/search`;

const stdioTool = {
  id: "tool-stdio",
  name: "run_local",
  description: "Runs locally",
  json_schema: { parameters: { type: "object", properties: {} } },
};
const httpTool = {
  id: "tool-http",
  name: "web_search",
  description: "Searches",
  json_schema: { parameters: { type: "object", properties: {} } },
};

function harness(hosted: boolean) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const client: UnifiedMcpClient = {
    get: async (path) => {
      if (path === serverPath) {
        return [
          {
            id: "mcp-stdio",
            server_name: "localrunner",
            mcp_server_type: "stdio",
            command: "npx",
            args: ["server"],
          },
          {
            id: "mcp-http",
            server_name: "webby",
            mcp_server_type: "streamable_http",
            server_url: "https://mcp.example.com/mcp",
          },
        ];
      }
      if (path === `${serverPath}/mcp-stdio/tools`) return [stdioTool];
      if (path === `${serverPath}/mcp-http/tools`) return [httpTool];
      return [];
    },
    post: async (path) => {
      if (path === searchPath) {
        return [
          { tool: { id: "tool-stdio", json_schema: null }, combined_score: 1 },
          { tool: { id: "tool-http", json_schema: null }, combined_score: 0.5 },
        ];
      }
      return {};
    },
  };
  const deps: McpSubcommandDependencies = {
    env: { LETTA_AGENT_ID: "agent-cloud" },
    initializeSettings: async () => {},
    isServerMcpAvailable: () => true,
    isHostedLettaCloud: () => hosted,
    getLocalServers: () => [],
    getClient: async () => client,
    stdout: (message: string) => stdout.push(message),
    stderr: (message: string) => stderr.push(message),
  };
  return { deps, stdout, stderr };
}

describe("stdio cloud servers on hosted Letta Cloud", () => {
  test("tools excludes stdio cloud servers when hosted", async () => {
    const hosted = harness(true);
    expect(await runMcpSubcommand(["tools"], hosted.deps)).toBe(0);
    const names = JSON.parse(hosted.stdout[0] ?? "[]").map(
      (tool: { name: string }) => tool.name,
    );
    expect(names).toEqual(["mcp__webby__web_search"]);

    const selfHosted = harness(false);
    expect(await runMcpSubcommand(["tools"], selfHosted.deps)).toBe(0);
    const allNames = JSON.parse(selfHosted.stdout[0] ?? "[]").map(
      (tool: { name: string }) => tool.name,
    );
    expect(allNames).toEqual([
      "mcp__localrunner__run_local",
      "mcp__webby__web_search",
    ]);
  });

  test("search drops stdio cloud results when hosted and keeps them otherwise", async () => {
    const hosted = harness(true);
    expect(await runMcpSubcommand(["search", "run"], hosted.deps)).toBe(0);
    const results = JSON.parse(hosted.stdout[0] ?? "[]");
    expect(results).toHaveLength(1);

    const selfHosted = harness(false);
    expect(await runMcpSubcommand(["search", "run"], selfHosted.deps)).toBe(0);
    expect(JSON.parse(selfHosted.stdout[0] ?? "[]")).toHaveLength(2);
  });

  test("call and schema reject stdio cloud tools when hosted", async () => {
    const hosted = harness(true);
    expect(
      await runMcpSubcommand(
        ["schema", "mcp__localrunner__run_local"],
        hosted.deps,
      ),
    ).toBe(1);
    expect(JSON.parse(hosted.stderr[0] ?? "{}").error.code).toBe(
      "tool_not_found",
    );
  });
});
