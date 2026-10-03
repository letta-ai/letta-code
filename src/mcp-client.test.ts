import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { connectMcpServer, connectStdioMcpServer } from "@/mcp-client";

function listenOnAvailablePort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate test port"));
        return;
      }
      resolve(address.port);
    });
  });
}

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

  test("a missing environment variable in an unrelated custom header still rejects exactly as before", async () => {
    let requestReceived = false;
    const server = createServer((_req, res) => {
      requestReceived = true;
      res.writeHead(200);
      res.end("{}");
    });
    const port = await listenOnAvailablePort(server);
    const envName = "LETTA_MCP_TEST_MISSING_OPTIONAL_2B9E";
    try {
      delete process.env[envName];
      await expect(
        connectMcpServer({
          name: "optional-missing",
          transport: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { "X-Optional": `\${${envName}}` },
        }),
      ).rejects.toThrow(
        `MCP header X-Optional references missing environment variable ${envName}`,
      );
      expect(requestReceived).toBe(false);
    } finally {
      server.close();
    }
  });

  test("rejects when the stdio command cannot start", async () => {
    expect(
      connectStdioMcpServer({
        name: "missing",
        command: "/nonexistent/mcp-server",
      }),
    ).rejects.toThrow();
  });

  test("rejects an empty-string environment value before any network request is made", async () => {
    let requestReceived = false;
    const server = createServer((_req, res) => {
      requestReceived = true;
      res.writeHead(200);
      res.end("{}");
    });
    const port = await listenOnAvailablePort(server);
    const envName = "LETTA_MCP_TEST_BLANK_TOKEN_EMPTY";
    try {
      process.env[envName] = "";
      await expect(
        connectMcpServer({
          name: "blank-empty",
          transport: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: `Bearer \${${envName}}` },
        }),
      ).rejects.toThrow(
        `MCP header Authorization references environment variable ${envName}, which is set but blank`,
      );
      expect(requestReceived).toBe(false);
    } finally {
      delete process.env[envName];
      server.close();
    }
  });

  test("rejects a whitespace-only environment value before any network request is made", async () => {
    let requestReceived = false;
    const server = createServer((_req, res) => {
      requestReceived = true;
      res.writeHead(200);
      res.end("{}");
    });
    const port = await listenOnAvailablePort(server);
    const envName = "LETTA_MCP_TEST_BLANK_TOKEN_WHITESPACE";
    try {
      process.env[envName] = "   ";
      await expect(
        connectMcpServer({
          name: "blank-whitespace",
          transport: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: `Bearer \${${envName}}` },
        }),
      ).rejects.toThrow(
        `MCP header Authorization references environment variable ${envName}, which is set but blank`,
      );
      expect(requestReceived).toBe(false);
    } finally {
      delete process.env[envName];
      server.close();
    }
  });

  test("a valid nonblank environment value resolves onto the wire unchanged", async () => {
    let capturedAuthorization: string | undefined;
    const server = createServer((req, res) => {
      capturedAuthorization = req.headers.authorization;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "not a real MCP server" },
        }),
      );
    });
    const port = await listenOnAvailablePort(server);
    const envName = "LETTA_MCP_TEST_VALID_TOKEN";
    try {
      process.env[envName] = "sk-real-nonblank-value";
      await connectMcpServer({
        name: "valid",
        transport: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: `Bearer \${${envName}}` },
      }).catch(() => undefined);
      expect(capturedAuthorization).toBe("Bearer sk-real-nonblank-value");
    } finally {
      delete process.env[envName];
      server.close();
    }
  });

  test("case-insensitive Authorization header names also reject a blank environment value", async () => {
    for (const headerName of ["authorization", "AUTHORIZATION"]) {
      let requestReceived = false;
      const server = createServer((_req, res) => {
        requestReceived = true;
        res.writeHead(200);
        res.end("{}");
      });
      const port = await listenOnAvailablePort(server);
      const envName = "LETTA_MCP_TEST_BLANK_TOKEN_CASE";
      try {
        process.env[envName] = "";
        await expect(
          connectMcpServer({
            name: "blank-case",
            transport: "http",
            url: `http://127.0.0.1:${port}/mcp`,
            headers: { [headerName]: `Bearer \${${envName}}` },
          }),
        ).rejects.toThrow(
          `MCP header ${headerName} references environment variable ${envName}, which is set but blank`,
        );
        expect(requestReceived).toBe(false);
      } finally {
        delete process.env[envName];
        server.close();
      }
    }
  });

  test("a blank environment value in an unrelated custom header does not throw and reaches the server", async () => {
    let requestReceived = false;
    let capturedOptional: string | undefined;
    const server = createServer((req, res) => {
      requestReceived = true;
      capturedOptional = req.headers["x-optional"] as string | undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "not a real MCP server" },
        }),
      );
    });
    const port = await listenOnAvailablePort(server);
    const envName = "LETTA_MCP_TEST_EMPTY_OPTIONAL";
    try {
      process.env[envName] = "";
      await connectMcpServer({
        name: "optional-empty",
        transport: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { "X-Optional": `\${${envName}}` },
      }).catch(() => undefined);
      expect(requestReceived).toBe(true);
      // Whatever the underlying HTTP runtime does with an empty header
      // value (send it empty, or omit it) is unrelated-header behavior
      // this fix must not change — only that it never throws and the
      // request still reaches the server.
      expect(capturedOptional ?? "").toBe("");
    } finally {
      delete process.env[envName];
      server.close();
    }
  });

  test("a nonblank environment value in an unrelated custom header is unaffected", async () => {
    let capturedOptional: string | undefined;
    const server = createServer((req, res) => {
      capturedOptional = req.headers["x-optional"] as string | undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "not a real MCP server" },
        }),
      );
    });
    const port = await listenOnAvailablePort(server);
    const envName = "LETTA_MCP_TEST_NONEMPTY_OPTIONAL";
    try {
      process.env[envName] = "some-optional-value";
      await connectMcpServer({
        name: "optional-nonempty",
        transport: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { "X-Optional": `\${${envName}}` },
      }).catch(() => undefined);
      expect(capturedOptional).toBe("some-optional-value");
    } finally {
      delete process.env[envName];
      server.close();
    }
  });
});
