import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { connectMcpServer } from "@/mcp-client";
import { clearMcpOAuthCredentials, createMcpOAuthSession } from "@/mcp-oauth";
import { setServiceName } from "@/utils/secrets";

const OAUTH_SERVER = fileURLToPath(
  new URL(
    "../examples/server/simpleStreamableHttp.js",
    import.meta.resolve("@modelcontextprotocol/sdk/client"),
  ),
);
const AGENT_ID = "agent-oauth-test";
const SERVER_NAME = "oauth-demo";
let serverUrl: string | undefined;
let serverProcess: ChildProcess | undefined;

afterEach(async () => {
  serverProcess?.kill();
  serverProcess = undefined;
  if (serverUrl) {
    await clearMcpOAuthCredentials(AGENT_ID, SERVER_NAME, serverUrl);
  }
  serverUrl = undefined;
  setServiceName("letta-code");
});

describe("MCP OAuth", () => {
  test("cancels a pending browser callback cleanly", async () => {
    setServiceName("letta-code-mcp-oauth-test");
    serverUrl = "https://oauth-cancellation.example/mcp";
    const oauth = await createMcpOAuthSession(
      AGENT_ID,
      SERVER_NAME,
      serverUrl,
      { interactive: true },
    );
    if (!oauth?.waitForAuthorizationCode)
      throw new Error("Interactive OAuth callback was not created");

    const authorizationCode = oauth.waitForAuthorizationCode();
    await oauth.close();
    await expect(authorizationCode).rejects.toThrow("cancelled");
  });

  test("completes discovery, DCR, PKCE, callback, and authenticated connection", async () => {
    setServiceName("letta-code-mcp-oauth-test");
    const mcpPort = await availablePort();
    const authPort = await availablePort();
    serverUrl = `http://localhost:${mcpPort}/mcp`;
    serverProcess = spawn(process.execPath, [OAUTH_SERVER, "--oauth"], {
      stdio: "ignore",
      env: {
        ...process.env,
        MCP_PORT: String(mcpPort),
        MCP_AUTH_PORT: String(authPort),
      },
    });
    await waitForServer(serverUrl);

    const oauth = await createMcpOAuthSession(
      AGENT_ID,
      SERVER_NAME,
      serverUrl,
      {
        interactive: true,
        openBrowser: async (authorizationUrl) => {
          const response = await fetch(authorizationUrl, {
            redirect: "follow",
          });
          await response.text();
        },
      },
    );
    if (!oauth) throw new Error("OAuth session was not created");

    const connection = await connectMcpServer(
      {
        name: SERVER_NAME,
        transport: "http",
        url: serverUrl,
      },
      { oauth },
    );

    expect(connection.tools.length).toBeGreaterThan(0);
    await connection.close();

    const otherAgentOAuth = await createMcpOAuthSession(
      "agent-without-oauth",
      SERVER_NAME,
      serverUrl,
      { interactive: false },
    );
    expect(otherAgentOAuth).toBeUndefined();

    const persistedOAuth = await createMcpOAuthSession(
      AGENT_ID,
      SERVER_NAME,
      serverUrl,
      { interactive: false },
    );
    if (!persistedOAuth)
      throw new Error("OAuth credentials were not persisted");
    const resumed = await connectMcpServer(
      {
        name: SERVER_NAME,
        transport: "http",
        url: serverUrl,
      },
      { oauth: persistedOAuth },
    );
    expect(resumed.tools.length).toBeGreaterThan(0);
    await resumed.close();
  }, 30_000);
});

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (serverProcess?.exitCode !== null) {
      throw new Error(
        `OAuth test server exited with ${serverProcess?.exitCode}`,
      );
    }
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Timed out waiting for OAuth test server");
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate test port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}
