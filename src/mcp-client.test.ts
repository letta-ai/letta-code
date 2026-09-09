import { describe, expect, test } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
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

  test("falls back to legacy HTTP+SSE when an http-configured server only speaks SSE", async () => {
    const mcp = new McpServer({ name: "legacy-sse", version: "1.0.0" });
    mcp.registerTool(
      "echo",
      {
        description: "Echo a message",
        inputSchema: { message: z.string() },
      },
      async ({ message }) => ({
        content: [{ type: "text" as const, text: `Echo: ${message}` }],
      }),
    );

    const transports = new Map<string, SSEServerTransport>();
    const httpServer = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        mcp.connect(transport).catch(() => undefined);
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/messages")) {
        const sessionId = new URL(req.url, "http://localhost").searchParams.get(
          "sessionId",
        );
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (transport) {
          transport.handlePostMessage(req, res).catch(() => undefined);
          return;
        }
      }
      // No streamable HTTP endpoint: answer every other method/url with 404,
      // like a server that only speaks the legacy HTTP+SSE transport.
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = httpServer.address() as AddressInfo;

    const server = await connectMcpServer({
      name: "legacy-sse",
      transport: "http",
      url: `http://127.0.0.1:${port}/sse`,
    });

    try {
      expect(server.tools.map((tool) => tool.name)).toContain("echo");
      const result = await server.callTool("echo", { message: "hello" });
      expect(result.content).toEqual([{ type: "text", text: "Echo: hello" }]);
    } finally {
      await server.close();
      await Promise.all(
        [...transports.values()].map((transport) =>
          transport.close().catch(() => undefined),
        ),
      );
      await mcp.close().catch(() => undefined);
      httpServer.close();
    }
  });

  test("does not fall back to SSE for other streamable HTTP errors", async () => {
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(500).end();
    });
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = httpServer.address() as AddressInfo;

    try {
      await expect(
        connectMcpServer({
          name: "broken",
          transport: "http",
          url: `http://127.0.0.1:${port}/sse`,
        }),
      ).rejects.toThrow("Error POSTing to endpoint");
    } finally {
      httpServer.close();
    }
  });
});
