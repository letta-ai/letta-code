import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { connectMcpServer, connectStdioMcpServer } from "@/mcp-client";

const EVERYTHING_SERVER = fileURLToPath(
  new URL(
    "./dist/index.js",
    import.meta.resolve("@modelcontextprotocol/server-everything/package.json"),
  ),
);

describe("client-side MCP", () => {
  test("starts a stdio server, lists tools, and proxies calls", async () => {
    const server = await connectStdioMcpServer(
      {
        name: "everything",
        command: process.execPath,
        args: [EVERYTHING_SERVER],
      },
      { stderr: "pipe" },
    );

    try {
      expect(server.tools.map((tool) => tool.name)).toContain("echo");
      const echo = server.tools.find((tool) => tool.name === "echo");
      expect(echo?.inputSchema).toMatchObject({
        type: "object",
        properties: { message: { type: "string" } },
      });
      const result = await server.callTool("echo", { message: "hello" });
      expect(result.content).toEqual([{ type: "text", text: "Echo: hello" }]);
    } finally {
      await server.close();
    }
  });

  test("forwards environment variables to the local server", async () => {
    const server = await connectStdioMcpServer(
      {
        name: "everything",
        command: process.execPath,
        args: [EVERYTHING_SERVER],
        env: { LETTA_MCP_TEST_VALUE: "client-side" },
      },
      { stderr: "pipe" },
    );

    try {
      const result = await server.callTool("get-env");
      expect(JSON.stringify(result.content)).toContain("LETTA_MCP_TEST_VALUE");
      expect(JSON.stringify(result.content)).toContain("client-side");
    } finally {
      await server.close();
    }
  });

  test("rejects remote headers with unresolved environment variables", async () => {
    expect(
      connectMcpServer({
        name: "secure",
        transport: "http",
        url: "https://mcp.example.invalid/mcp",
        headers: {
          Authorization: "Bearer $" + "{LETTA_MCP_TEST_MISSING_TOKEN_7F4C}",
        },
      }),
    ).rejects.toThrow(
      "MCP header Authorization references missing environment variable LETTA_MCP_TEST_MISSING_TOKEN_7F4C",
    );
  });

  test("rejects when the stdio command cannot start", async () => {
    expect(
      connectStdioMcpServer({
        name: "missing",
        command: "/nonexistent/mcp-server",
      }),
    ).rejects.toThrow();
  });
});
