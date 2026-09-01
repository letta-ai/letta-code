import { describe, expect, test } from "bun:test";
import type { McpToolDefinition } from "@/mcp-client";
import {
  type McpSearchRequest,
  mergeMcpSearchResults,
  runMcpSearch,
  searchLocalMcpTools,
} from "./mcp-search";

describe("runMcpSearch", () => {
  test("uses hybrid search with a default limit of five", async () => {
    const requests: McpSearchRequest[] = [];
    const stdout: string[] = [];
    await expect(
      runMcpSearch({
        searchTools: async (request) => {
          requests.push(request);
          return [
            {
              tool: {
                name: "mcp__betterstack__render_chart",
                description: "Render a chart",
                parameters: { type: "object", properties: {} },
              },
              score: 0.5,
            },
          ];
        },
        query: " charts ",
        mode: undefined,
        limit: undefined,
        stdout: (message) => stdout.push(message),
      }),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      { query: "charts", searchMode: "hybrid", limit: 5 },
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
    const requests: McpSearchRequest[] = [];
    await runMcpSearch({
      searchTools: async (request) => {
        requests.push(request);
        return [];
      },
      query: "charts",
      mode: "fts",
      limit: "2",
      stdout: () => {},
    });
    expect(requests).toEqual([
      { query: "charts", searchMode: "fts", limit: 2 },
    ]);
  });

  test("rejects missing queries and invalid options before searching", async () => {
    let searches = 0;
    const base = {
      searchTools: async () => {
        searches++;
        return [];
      },
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
    expect(searches).toBe(0);
  });
});

describe("merged MCP search results", () => {
  test("combines local and server results by score with a stable limit", () => {
    expect(
      mergeMcpSearchResults(
        [
          { tool: { name: "mcp__server__charts" }, score: 0.008 },
          { tool: { name: "mcp__server__other" }, score: 0.007 },
        ],
        [
          { tool: { name: "mcp__local__exact" }, score: 1 },
          { tool: { name: "mcp__local__schema-only" }, score: 0.25 },
        ],
        4,
      ),
    ).toEqual([
      { tool: { name: "mcp__local__exact" }, score: 1 },
      { tool: { name: "mcp__server__charts" }, score: 1 },
      { tool: { name: "mcp__server__other" }, score: 0.5 },
      { tool: { name: "mcp__local__schema-only" }, score: 0.125 },
    ]);
  });
});

describe("local MCP tool search", () => {
  const tools: McpToolDefinition[] = [
    {
      name: "mcp__everything__echo",
      title: "Echo Tool",
      description: "Echoes back the input message",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
      },
    },
    {
      name: "mcp__everything__get_tiny_image",
      description: "Returns a tiny test image",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "mcp__everything__print_env",
      description: "Returns an environment value",
      inputSchema: {
        type: "object",
        properties: { variableName: { type: "string" } },
      },
    },
  ];

  test("ranks local names and descriptions without an API index", () => {
    expect(
      searchLocalMcpTools({
        tools,
        query: "echo messages",
        searchMode: "hybrid",
        limit: 5,
      }),
    ).toEqual([
      {
        tool: {
          name: "mcp__everything__echo",
          title: "Echo Tool",
          description: "Echoes back the input message",
          parameters: {
            type: "object",
            properties: { message: { type: "string" } },
          },
        },
        score: 0.75,
      },
    ]);
  });

  test("searches input schema fields, enforces limits, and has stable ties", () => {
    expect(
      searchLocalMcpTools({
        tools,
        query: "string",
        searchMode: "fts",
        limit: 1,
      }),
    ).toEqual([
      {
        tool: {
          name: "mcp__everything__echo",
          title: "Echo Tool",
          description: "Echoes back the input message",
          parameters: {
            type: "object",
            properties: { message: { type: "string" } },
          },
        },
        score: 0.25,
      },
    ]);
  });

  test("rejects vector mode because local agents have no MCP embedding index", () => {
    expect(() =>
      searchLocalMcpTools({
        tools,
        query: "echo",
        searchMode: "vector",
        limit: 5,
      }),
    ).toThrow("Vector MCP tool search is unavailable with the local backend");
  });
});
