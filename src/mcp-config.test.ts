import { describe, expect, test } from "bun:test";
import { buildMcpServerConfig, parseMcpTransport } from "./mcp-config";

describe("MCP connection configuration", () => {
  test("normalizes the streamable HTTP transport spelling", () => {
    expect(parseMcpTransport("streamable_http")).toBe("http");
    expect(parseMcpTransport("HTTP")).toBe("http");
  });

  test("builds a stdio config without losing child arguments", () => {
    expect(
      buildMcpServerConfig("files", {
        transport: "stdio",
        childCommand: [
          "npx",
          "-y",
          "@modelcontextprotocol/server-filesystem",
          ".",
        ],
        cwd: undefined,
        defaultCwd: "/workspace",
        env: ["MODE=read-only", "EMPTY="],
        headers: [],
      }),
    ).toEqual({
      name: "files",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      cwd: "/workspace",
      env: { MODE: "read-only", EMPTY: "" },
    });
  });

  test("stores an auth environment reference instead of its value", () => {
    expect(
      buildMcpServerConfig("private", {
        transport: "http",
        url: "https://mcp.example.com/mcp",
        defaultCwd: "/workspace",
        childCommand: [],
        env: [],
        headers: ["X-Tenant: letta"],
        authEnv: "MCP_API_TOKEN",
      }),
    ).toEqual({
      name: "private",
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: {
        "X-Tenant": "letta",
        Authorization: "Bearer $" + "{MCP_API_TOKEN}",
      },
    });
  });

  test("rejects malformed connection options", () => {
    expect(() => parseMcpTransport("websocket")).toThrow(
      "Unknown MCP transport",
    );
    expect(() =>
      buildMcpServerConfig("bad", {
        transport: "http",
        url: "not a URL",
        defaultCwd: "/workspace",
        childCommand: [],
        env: [],
        headers: [],
      }),
    ).toThrow("Invalid MCP URL");
  });
});
