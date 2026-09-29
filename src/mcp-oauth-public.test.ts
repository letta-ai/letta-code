import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  authorizeMcpServerWithStorage,
  type McpOAuthStorage,
} from "@/mcp-oauth-public";

const OAUTH_SERVER = fileURLToPath(
  new URL(
    "../examples/server/simpleStreamableHttp.js",
    import.meta.resolve("@modelcontextprotocol/sdk/client"),
  ),
);
const SERVER_NAME = "oauth-fetch-test";

let serverProcess: ChildProcess | undefined;
let serverUrl: string | undefined;

afterEach(() => {
  serverProcess?.kill();
  serverProcess = undefined;
  serverUrl = undefined;
});

describe("public MCP OAuth fetch injection", () => {
  test("does not share an authorization flight across fetch policies", async () => {
    const firstFetchStarted = Promise.withResolvers<void>();
    const firstController = new AbortController();
    const storage = memoryStorage();
    const first = authorizeMcpServerWithStorage({
      agentId: "agent-distinct-fetch",
      fetch: async (_url, init) => {
        firstFetchStarted.resolve();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
      openBrowser: async () => undefined,
      serverName: SERVER_NAME,
      serverUrl: "https://mcp.example.invalid/mcp",
      signal: firstController.signal,
      storage,
      storageNamespace: "test-distinct-fetch",
    });
    await firstFetchStarted.promise;

    await expect(
      authorizeMcpServerWithStorage({
        agentId: "agent-distinct-fetch",
        fetch: async () => {
          throw new Error("Second fetch policy ran");
        },
        openBrowser: async () => undefined,
        serverName: SERVER_NAME,
        serverUrl: "https://mcp.example.invalid/mcp",
        storage,
        storageNamespace: "test-distinct-fetch",
      }),
    ).rejects.toThrow("Second fetch policy ran");

    firstController.abort();
    await expect(first).rejects.toBeDefined();
  });

  test("uses the caller fetch for discovery, DCR, token exchange, and MCP requests", async () => {
    await startOAuthServer();
    if (!serverUrl) throw new Error("OAuth test server was not started");

    const requestUrls: string[] = [];
    const providerFetch: FetchLike = async (url, init) => {
      requestUrls.push(String(url));
      return fetch(url, init);
    };
    const credentials = await authorizeMcpServerWithStorage({
      agentId: "agent-fetch-propagation",
      fetch: providerFetch,
      openBrowser: async (authorizationUrl) => {
        const response = await fetch(authorizationUrl, { redirect: "follow" });
        await response.text();
      },
      serverName: SERVER_NAME,
      serverUrl,
      storage: memoryStorage(),
      storageNamespace: "test-fetch-propagation",
    });

    expect(credentials.access_token).toBeTruthy();
    const paths = requestUrls.map((url) => new URL(url).pathname);
    expect(paths).toContain("/.well-known/oauth-protected-resource/mcp");
    expect(paths).toContain("/.well-known/oauth-authorization-server");
    expect(paths).toContain("/register");
    expect(paths).toContain("/token");
    expect(paths).toContain("/mcp");
  }, 30_000);

  test("rejects a discovered endpoint before the underlying fetch", async () => {
    await startOAuthServer();
    if (!serverUrl) throw new Error("OAuth test server was not started");

    const maliciousRegistrationUrl =
      "http://169.254.169.254/latest/oauth/register";
    const guardedUrls: string[] = [];
    const underlyingUrls: string[] = [];
    const underlyingFetch: FetchLike = async (url, init) => {
      const value = String(url);
      underlyingUrls.push(value);
      const response = await fetch(url, init);
      if (
        new URL(value).pathname !== "/.well-known/oauth-authorization-server"
      ) {
        return response;
      }
      const metadata = await response.json();
      if (
        typeof metadata !== "object" ||
        metadata === null ||
        Array.isArray(metadata)
      ) {
        throw new Error("OAuth metadata response was not an object");
      }
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.set("content-type", "application/json");
      return new Response(
        JSON.stringify({
          ...metadata,
          registration_endpoint: maliciousRegistrationUrl,
        }),
        { headers, status: response.status },
      );
    };
    const guardedFetch: FetchLike = async (url, init) => {
      const value = String(url);
      guardedUrls.push(value);
      if (value === maliciousRegistrationUrl) {
        throw new Error("Blocked unsafe OAuth provider endpoint");
      }
      return underlyingFetch(url, init);
    };

    await expect(
      authorizeMcpServerWithStorage({
        agentId: "agent-malicious-provider",
        fetch: guardedFetch,
        openBrowser: async () => {
          throw new Error("Browser must not open after endpoint rejection");
        },
        serverName: SERVER_NAME,
        serverUrl,
        storage: memoryStorage(),
        storageNamespace: "test-malicious-provider",
      }),
    ).rejects.toThrow("Blocked unsafe OAuth provider endpoint");
    expect(guardedUrls).toContain(maliciousRegistrationUrl);
    expect(underlyingUrls).not.toContain(maliciousRegistrationUrl);
  }, 30_000);
});

function memoryStorage(): McpOAuthStorage {
  const values = new Map<string, string>();
  return {
    get: async (credentialKey) => values.get(credentialKey),
    set: async (credentialKey, value) => {
      values.set(credentialKey, value);
    },
    delete: async (credentialKey) => values.delete(credentialKey),
  };
}

async function startOAuthServer(): Promise<void> {
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
}

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
