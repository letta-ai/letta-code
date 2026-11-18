import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  authorizeMcpServerWithStorage,
  type McpOAuthFetch,
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

    const requests: Array<{
      authorization: string | null;
      method: string;
      url: string;
    }> = [];
    const providerFetch: McpOAuthFetch = async (url, init) => {
      requests.push({
        authorization: new Headers(init?.headers).get("authorization"),
        method: init?.method ?? "GET",
        url: String(url),
      });
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
    const paths = requests.map(({ url }) => new URL(url).pathname);
    expect(paths).toContain("/.well-known/oauth-protected-resource/mcp");
    expect(paths).toContain("/.well-known/oauth-authorization-server");
    expect(paths).toContain("/register");
    expect(paths).toContain("/token");
    expect(paths).toContain("/mcp");
    const mcpRequests = requests.filter(
      ({ url }) => new URL(url).pathname === "/mcp",
    );
    expect(mcpRequests.length).toBeGreaterThanOrEqual(2);
    expect(
      mcpRequests.some(({ authorization }) => authorization === null),
    ).toBe(true);
    expect(
      mcpRequests.some(({ authorization }) =>
        authorization?.toLowerCase().startsWith("bearer "),
      ),
    ).toBe(true);
  }, 30_000);

  test("passes the callback domain to the hook before token exchange", async () => {
    await startOAuthServer();
    if (!serverUrl) throw new Error("OAuth test server was not started");
    const paths: string[] = [];
    const domains: Array<string | undefined> = [];
    await expect(
      authorizeMcpServerWithStorage({
        agentId: "agent-callback-domain",
        fetch: async (url, init) => {
          paths.push(new URL(String(url)).pathname);
          return fetch(url, init);
        },
        onAuthorizationCallback: ({ domain }) => {
          domains.push(domain);
          throw new Error("site mismatch");
        },
        openBrowser: async (authorizationUrl) => {
          const authorize = await fetch(authorizationUrl, {
            redirect: "manual",
          });
          await authorize.text();
          const callback = new URL(authorize.headers.get("location") ?? "");
          callback.searchParams.set("domain", "us5.datadoghq.com");
          await (await fetch(callback)).text();
        },
        serverName: SERVER_NAME,
        serverUrl,
        storage: memoryStorage(),
        storageNamespace: "test-callback-domain",
      }),
    ).rejects.toThrow("site mismatch");
    expect(domains).toEqual(["us5.datadoghq.com"]);
    expect(paths).not.toContain("/token");
  }, 30_000);

  test("rejects a discovered endpoint before the underlying fetch", async () => {
    await startOAuthServer();
    if (!serverUrl) throw new Error("OAuth test server was not started");

    const maliciousRegistrationUrl =
      "http://169.254.169.254/latest/oauth/register";
    const guardedUrls: string[] = [];
    const underlyingUrls: string[] = [];
    const underlyingFetch: McpOAuthFetch = async (url, init) => {
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
    const guardedFetch: McpOAuthFetch = async (url, init) => {
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

// The fixture exits with 1 when either port is already taken. A port probed
// free can be claimed by another process before the fixture binds it, so a
// startup exit is retried on fresh ports. Its stderr is kept for the error.
async function startOAuthServer(): Promise<void> {
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    const mcpPort = await availablePort();
    let authPort = await availablePort();
    while (authPort === mcpPort) authPort = await availablePort();
    const url = `http://localhost:${mcpPort}/mcp`;
    let stderr = "";
    const child = spawn(process.execPath, [OAUTH_SERVER, "--oauth"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        MCP_PORT: String(mcpPort),
        MCP_AUTH_PORT: String(authPort),
      },
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    serverProcess = child;
    const started = await waitForServer(child, url);
    if (started === "ready") {
      serverUrl = url;
      return;
    }
    if (started === "timeout") {
      throw new Error(
        `Timed out waiting for OAuth test server\n${stderr.trim()}`,
      );
    }
    if (attempt >= attempts) {
      throw new Error(
        `OAuth test server exited with ${child.exitCode} on ${attempts} attempts\n${stderr.trim()}`,
      );
    }
  }
}

async function waitForServer(
  child: ChildProcess,
  url: string,
): Promise<"ready" | "exited" | "timeout"> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return "exited";
    try {
      await fetch(url);
      return "ready";
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return "timeout";
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
