import { describe, expect, test } from "bun:test";
import type { UnifiedMcpClient } from "@/backend/api/unified-mcp";
import { runMcpSearch } from "./mcp-search";

function searchClient(
  calls: Array<{ path: string; body: unknown }>,
): Pick<UnifiedMcpClient, "post"> {
  return {
    post: async (path, options) => {
      calls.push({ path, body: options?.body });
      return [
        {
          tool: {
            id: "tool-1",
            json_schema: {
              name: "mcp__betterstack__render_chart",
              description: "Render a chart",
              parameters: { type: "object", properties: {} },
            },
          },
          combined_score: 0.5,
        },
      ];
    },
  };
}

describe("runMcpSearch", () => {
  test("uses hybrid search with a default limit of five", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const stdout: string[] = [];
    await expect(
      runMcpSearch({
        getClient: async () => searchClient(calls),
        agentId: "agent-1",
        query: " charts ",
        mode: undefined,
        limit: undefined,
        stdout: (message) => stdout.push(message),
      }),
    ).resolves.toBe(0);

    expect(calls).toEqual([
      {
        path: "/v1/agents/agent-1/mcp-servers/tools/search",
        body: { query: "charts", search_mode: "hybrid", limit: 5 },
      },
    ]);
    expect(JSON.parse(stdout[0] ?? "[]")).toEqual([
      {
        tool: {
          name: "mcp__betterstack__render_chart",
          description: "Render a chart",
          parameters: { type: "object", properties: {} },
        },
        rank: 1,
        score: 0.5,
      },
    ]);
  });

  test("passes explicit search mode and limit", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    await runMcpSearch({
      getClient: async () => searchClient(calls),
      agentId: "agent-1",
      query: "charts",
      mode: "fts",
      limit: "2",
      stdout: () => {},
    });
    expect(calls[0]?.body).toEqual({
      query: "charts",
      search_mode: "fts",
      limit: 2,
    });
  });

  test("rejects missing queries and invalid options", async () => {
    const client = searchClient([]);
    let clientRequests = 0;
    const base = {
      getClient: async () => {
        clientRequests++;
        return client;
      },
      agentId: "agent-1",
      query: "charts",
      mode: undefined,
      limit: undefined,
      stdout: () => {},
    };
    await expect(runMcpSearch({ ...base, query: " " })).rejects.toMatchObject({
      code: "invalid_arguments",
    });
    await expect(
      runMcpSearch({ ...base, mode: "semantic" }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(runMcpSearch({ ...base, limit: "101" })).rejects.toMatchObject(
      { code: "invalid_arguments" },
    );
    expect(clientRequests).toBe(0);
  });
});
