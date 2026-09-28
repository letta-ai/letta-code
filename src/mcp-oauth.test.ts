import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { connectMcpServer } from "@/mcp-client";
import {
  clearMcpOAuthCredentials,
  createMcpOAuthSession,
  createMcpOAuthSessionWithStorage,
  type McpOAuthStorage,
} from "@/mcp-oauth";
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

describe("storage-injected MCP OAuth", () => {
  test("persists and exports credentials under only the opaque credential key", async () => {
    const values = new Map<string, string>();
    const touchedKeys: string[] = [];
    const storage = memoryStorage(values, touchedKeys);
    const oauth = await createMcpOAuthSessionWithStorage({
      credentialKey: "desktop-connection-one",
      storage,
      interactive: true,
      openBrowser: async () => {},
    });
    if (!oauth) throw new Error("OAuth session was not created");

    if (!oauth.authProvider.saveClientInformation) {
      throw new Error("OAuth provider cannot save client information");
    }
    oauth.authProvider.saveClientInformation({
      client_id: "dcr-client",
      client_secret: "dcr-secret",
      redirect_uris: [String(oauth.authProvider.redirectUrl)],
    });
    await oauth.authProvider.saveTokens({
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "tools resources",
    });

    expect(touchedKeys).toEqual([
      "desktop-connection-one",
      "desktop-connection-one",
    ]);
    expect(oauth.exportCredentials()).toEqual({
      access_token: "access-token",
      refresh_token: "refresh-token",
      client_id: "dcr-client",
      client_secret: "dcr-secret",
      redirect_uri: String(oauth.authProvider.redirectUrl),
      token_type: "Bearer",
      expires_in: 3600,
      scope: "tools resources",
    });

    await oauth.authProvider.saveTokens({
      access_token: "refreshed-access-token",
      token_type: "Bearer",
      expires_in: 7200,
      scope: "tools resources",
    });
    expect(oauth.exportCredentials()).toMatchObject({
      refresh_token: "refresh-token",
      expires_in: 7200,
    });

    const persisted = JSON.parse(values.get("desktop-connection-one") ?? "{}");
    persisted.tokenExpiresAt = Date.now() + 1500;
    values.set("desktop-connection-one", JSON.stringify(persisted));

    const isolated = await createMcpOAuthSessionWithStorage({
      credentialKey: "desktop-connection-two",
      storage,
      interactive: false,
      openBrowser: async () => {},
    });
    expect(isolated).toBeUndefined();

    const resumed = await createMcpOAuthSessionWithStorage({
      credentialKey: "desktop-connection-one",
      storage,
      interactive: false,
      openBrowser: async () => {},
    });
    expect(resumed?.exportCredentials().access_token).toBe(
      "refreshed-access-token",
    );
    expect(resumed?.exportCredentials().expires_in).toBeLessThanOrEqual(2);
    await oauth.close();
    await resumed?.close();
  });

  test("rejects credential export before authorization completes", async () => {
    const oauth = await createMcpOAuthSessionWithStorage({
      credentialKey: "incomplete",
      storage: memoryStorage(),
      interactive: true,
      openBrowser: async () => {},
    });
    if (!oauth) throw new Error("OAuth session was not created");

    expect(() => oauth.exportCredentials()).toThrow("not complete");
    await oauth.close();
  });

  test("cancels a pending browser callback cleanly", async () => {
    const oauth = await createMcpOAuthSessionWithStorage({
      credentialKey: "cancelled",
      storage: memoryStorage(),
      interactive: true,
      openBrowser: async () => {},
    });
    if (!oauth?.waitForAuthorizationCode)
      throw new Error("Interactive OAuth callback was not created");

    const authorizationCode = oauth.waitForAuthorizationCode();
    const cancellation = rejectionMessage(authorizationCode);
    await oauth.close();
    expect(await cancellation).toContain("cancelled");
  });

  test("serializes same-key writes and invalidation across sessions", async () => {
    const values = new Map<string, string>();
    const blockedWrites = new Map<
      number,
      {
        started: ReturnType<typeof deferred>;
        release: ReturnType<typeof deferred>;
      }
    >();
    let writeCount = 0;
    const storage: McpOAuthStorage = {
      get: async (key) => values.get(key),
      set: async (key, value) => {
        writeCount += 1;
        const blocker = blockedWrites.get(writeCount);
        if (blocker) {
          blocker.started.resolve();
          await blocker.release.promise;
        }
        values.set(key, value);
      },
      delete: async (key) => values.delete(key),
    };
    const oauth = await createMcpOAuthSessionWithStorage({
      credentialKey: "serialized-writes",
      storage,
      interactive: true,
    });
    const secondOauth = await createMcpOAuthSessionWithStorage({
      credentialKey: "serialized-writes",
      storage,
      interactive: true,
    });
    if (!oauth || !secondOauth) {
      throw new Error("OAuth sessions were not created");
    }

    const firstWrite = { started: deferred(), release: deferred() };
    blockedWrites.set(1, firstWrite);
    const oldWrite = oauth.authProvider.saveTokens({
      access_token: "old-access-token",
      token_type: "Bearer",
    });
    await firstWrite.started.promise;
    const newWrite = secondOauth.authProvider.saveTokens({
      access_token: "new-access-token",
      token_type: "Bearer",
    });
    firstWrite.release.resolve();
    await Promise.all([oldWrite, newWrite]);
    expect(
      JSON.parse(values.get("serialized-writes") ?? "{}").tokens.access_token,
    ).toBe("new-access-token");

    const pendingWrite = { started: deferred(), release: deferred() };
    blockedWrites.set(3, pendingWrite);
    const saveBeforeDelete = oauth.authProvider.saveTokens({
      access_token: "delete-me",
      token_type: "Bearer",
    });
    await pendingWrite.started.promise;
    if (!secondOauth.authProvider.invalidateCredentials) {
      throw new Error("OAuth provider cannot invalidate credentials");
    }
    const invalidate = secondOauth.authProvider.invalidateCredentials("all");
    pendingWrite.release.resolve();
    await Promise.all([saveBeforeDelete, invalidate]);
    expect(values.has("serialized-writes")).toBe(false);
    await oauth.close();
    await secondOauth.close();
  });

  test("ignores unsolicited callbacks and accepts the expected state", async () => {
    const oauth = await createMcpOAuthSessionWithStorage({
      credentialKey: "callback-state",
      storage: memoryStorage(),
      interactive: true,
    });
    if (!oauth?.waitForAuthorizationCode || !oauth.authProvider.state) {
      throw new Error("Interactive OAuth callback was not created");
    }
    const expectedState = await oauth.authProvider.state();
    const redirectUrl = String(oauth.authProvider.redirectUrl);
    const authorizationCode = oauth.waitForAuthorizationCode();

    const wrongCode = await fetch(
      `${redirectUrl}?code=attacker-code&state=wrong-state`,
    );
    expect(wrongCode.status).toBe(400);
    const wrongError = await fetch(
      `${redirectUrl}?error=access_denied&state=wrong-state`,
    );
    expect(wrongError.status).toBe(400);

    const valid = await fetch(
      `${redirectUrl}?code=expected-code&state=${encodeURIComponent(expectedState)}`,
    );
    expect(valid.status).toBe(200);
    await expect(authorizationCode).resolves.toBe("expected-code");
    await oauth.close();
  });

  test("rejects an OAuth error carrying the expected state", async () => {
    const oauth = await createMcpOAuthSessionWithStorage({
      credentialKey: "callback-error",
      storage: memoryStorage(),
      interactive: true,
    });
    if (!oauth?.waitForAuthorizationCode || !oauth.authProvider.state) {
      throw new Error("Interactive OAuth callback was not created");
    }
    const expectedState = await oauth.authProvider.state();
    const authorizationCode = oauth.waitForAuthorizationCode();
    const authorizationError = rejectionMessage(authorizationCode);

    const response = await fetch(
      `${String(oauth.authProvider.redirectUrl)}?error=access_denied&state=${encodeURIComponent(expectedState)}`,
    );
    expect(response.status).toBe(400);
    expect(await authorizationError).toContain("access_denied");
    await oauth.close();
  });
});

describe("MCP OAuth", () => {
  test("keeps the agent-scoped Bun secrets wrapper", async () => {
    setServiceName("letta-code-mcp-oauth-test");
    serverUrl = "https://oauth-wrapper.example/mcp";
    const oauth = await createMcpOAuthSession(
      AGENT_ID,
      SERVER_NAME,
      serverUrl,
      { interactive: true },
    );
    expect(oauth).toBeDefined();
    await oauth?.close();
  });

  test("completes discovery, DCR, PKCE, callback, and credential export", async () => {
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

    const values = new Map<string, string>();
    const oauth = await createMcpOAuthSessionWithStorage({
      credentialKey: "desktop-real-flow",
      storage: memoryStorage(values),
      interactive: true,
      openBrowser: async (authorizationUrl) => {
        const response = await fetch(authorizationUrl, {
          redirect: "follow",
        });
        await response.text();
      },
    });
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
    const credentials = oauth.exportCredentials();
    expect(credentials.access_token).toBeTruthy();
    expect(credentials.client_id).toBeTruthy();
    expect(credentials.redirect_uri).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    expect(values.has("desktop-real-flow")).toBe(true);
    await connection.close();

    const isolated = await createMcpOAuthSessionWithStorage({
      credentialKey: "desktop-other-flow",
      storage: memoryStorage(values),
      interactive: false,
      openBrowser: async () => {},
    });
    expect(isolated).toBeUndefined();

    const persistedOAuth = await createMcpOAuthSessionWithStorage({
      credentialKey: "desktop-real-flow",
      storage: memoryStorage(values),
      interactive: false,
      openBrowser: async () => {},
    });
    if (!persistedOAuth)
      throw new Error("OAuth credentials were not persisted");
    expect(persistedOAuth.exportCredentials().access_token).toBe(
      credentials.access_token,
    );
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

function memoryStorage(
  values = new Map<string, string>(),
  touchedKeys: string[] = [],
): McpOAuthStorage {
  return {
    get: async (credentialKey) => {
      touchedKeys.push(credentialKey);
      return values.get(credentialKey);
    },
    set: async (credentialKey, value) => {
      touchedKeys.push(credentialKey);
      values.set(credentialKey, value);
    },
    delete: async (credentialKey) => {
      touchedKeys.push(credentialKey);
      return values.delete(credentialKey);
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function rejectionMessage(promise: Promise<string>): Promise<string> {
  return promise.then(
    () => "resolved unexpectedly",
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );
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
