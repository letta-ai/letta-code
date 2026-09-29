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
  mcpOAuthCredentialKey,
} from "@/mcp-oauth";
import { authorizeMcpServerWithStorage } from "@/mcp-oauth-public";
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

    expect(touchedKeys).toHaveLength(3);
    expect(touchedKeys.every((key) => key === "desktop-connection-one")).toBe(
      true,
    );
    expect(await oauth.exportCredentials()).toEqual({
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
    expect(await oauth.exportCredentials()).toMatchObject({
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
    expect((await resumed?.exportCredentials())?.access_token).toBe(
      "refreshed-access-token",
    );
    expect(
      (await resumed?.exportCredentials())?.expires_in,
    ).toBeLessThanOrEqual(2);
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

    await expect(oauth.exportCredentials()).rejects.toThrow("not complete");
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

  test("accepts the first same-version response and ignores stale invalidation", async () => {
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
    const newWriteError = rejectionMessage(Promise.resolve(newWrite));
    firstWrite.release.resolve();
    await oldWrite;
    expect(await newWriteError).toContain("token response is stale");
    expect(
      JSON.parse(values.get("serialized-writes") ?? "{}").tokens.access_token,
    ).toBe("old-access-token");

    const pendingWrite = { started: deferred(), release: deferred() };
    blockedWrites.set(2, pendingWrite);
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
    expect(
      JSON.parse(values.get("serialized-writes") ?? "{}").tokens.access_token,
    ).toBe("delete-me");
    await oauth.close();
    await secondOauth.close();
  });

  test("orders state loading and corrupt cleanup after pending writes", async () => {
    const values = new Map<string, string>();
    const writeStarted = deferred();
    const releaseWrite = deferred();
    let blockWrite = false;
    const storage: McpOAuthStorage = {
      get: async (key) => values.get(key),
      set: async (key, value) => {
        if (blockWrite) {
          writeStarted.resolve();
          await releaseWrite.promise;
        }
        values.set(key, value);
      },
      delete: async (key) => values.delete(key),
    };
    const writer = await createMcpOAuthSessionWithStorage({
      credentialKey: "ordered-load",
      storage,
      interactive: true,
    });
    if (!writer) throw new Error("Writer OAuth session was not created");

    values.set("ordered-load", "{malformed-before-valid-write");
    blockWrite = true;
    const validWrite = writer.authProvider.saveTokens({
      access_token: "valid-access-token",
      token_type: "Bearer",
    });
    await writeStarted.promise;
    const readerPromise = createMcpOAuthSessionWithStorage({
      credentialKey: "ordered-load",
      storage,
      interactive: false,
    });
    releaseWrite.resolve();

    const reader = await readerPromise;
    await validWrite;
    const readerTokens = await reader?.authProvider.tokens();
    expect(readerTokens?.access_token).toBe("valid-access-token");
    expect(values.has("ordered-load")).toBe(true);
    await writer.close();
    await reader?.close();
  });

  test("merges stale session mutations onto the latest stored credentials", async () => {
    const key = "stale-session-merge";
    const values = new Map<string, string>([
      [
        key,
        JSON.stringify({
          redirectUrl: "http://127.0.0.1:45871/callback",
          clientInformation: {
            client_id: "current-client",
            redirect_uris: ["http://127.0.0.1:45871/callback"],
          },
          tokens: {
            access_token: "old-access-token",
            refresh_token: "old-refresh-token",
            token_type: "Bearer",
          },
          discoveryState: {
            authorizationServerUrl: "https://auth.example",
            resourceMetadataUrl: "https://old.example",
          },
        }),
      ],
    ]);
    const storage = memoryStorage(values);
    const sessions = await Promise.all(
      ["token-writer", "discovery-invalidator", "refresh-writer"].map(() =>
        createMcpOAuthSessionWithStorage({
          credentialKey: key,
          storage,
          interactive: false,
        }),
      ),
    );
    const [tokenWriter, discoveryInvalidator, refreshWriter] = sessions;
    if (!tokenWriter || !discoveryInvalidator || !refreshWriter) {
      throw new Error("Persisted OAuth sessions were not created");
    }

    await tokenWriter.authProvider.saveTokens({
      access_token: "new-access-token",
      refresh_token: "rotated-refresh-token",
      token_type: "Bearer",
    });
    if (!discoveryInvalidator.authProvider.invalidateCredentials) {
      throw new Error("OAuth provider cannot invalidate credentials");
    }
    await discoveryInvalidator.authProvider.invalidateCredentials("discovery");
    let persisted = JSON.parse(values.get(key) ?? "{}");
    expect(persisted.tokens).toMatchObject({
      access_token: "new-access-token",
      refresh_token: "rotated-refresh-token",
    });
    expect(persisted.discoveryState).toBeUndefined();

    expect((await refreshWriter.exportCredentials()).refresh_token).toBe(
      "rotated-refresh-token",
    );
    expect((await refreshWriter.authProvider.tokens())?.refresh_token).toBe(
      "rotated-refresh-token",
    );
    await refreshWriter.authProvider.saveTokens({
      access_token: "newest-access-token",
      token_type: "Bearer",
    });
    persisted = JSON.parse(values.get(key) ?? "{}");
    expect(persisted.tokens).toMatchObject({
      access_token: "newest-access-token",
      refresh_token: "rotated-refresh-token",
    });
    await Promise.all(sessions.map((session) => session?.close()));
  });

  test("prevents late token responses from resurrecting cleared credentials", async () => {
    const key = "cleared-generation";
    const redirectUrl = "http://127.0.0.1:45872/callback";
    const values = new Map<string, string>([
      [
        key,
        JSON.stringify({
          redirectUrl,
          clientInformation: {
            client_id: "invalid-client",
            redirect_uris: [redirectUrl],
          },
          tokens: {
            access_token: "old-access",
            refresh_token: "old-refresh",
            token_type: "Bearer",
          },
          discoveryState: {
            authorizationServerUrl: "https://auth.example",
            resourceMetadataUrl: "https://old.example",
          },
        }),
      ],
    ]);
    const storage = memoryStorage(values);
    const stale = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage,
      interactive: false,
    });
    const invalidator = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage,
      interactive: false,
    });
    if (!stale || !invalidator?.authProvider.invalidateCredentials) {
      throw new Error("Persisted OAuth sessions were not created");
    }

    stale.authProvider.tokens();
    invalidator.authProvider.tokens();
    await invalidator.authProvider.invalidateCredentials("all");
    await expect(
      stale.authProvider.saveTokens({
        access_token: "late-response",
        token_type: "Bearer",
      }),
    ).rejects.toThrow("session is stale");
    expect(() =>
      stale.authProvider.saveClientInformation?.({
        client_id: "stale-client",
        redirect_uris: [redirectUrl],
      }),
    ).toThrow("session is stale");
    expect(() =>
      stale.authProvider.saveDiscoveryState?.({
        authorizationServerUrl: "https://stale-auth.example",
      }),
    ).toThrow("session is stale");
    await expect(
      invalidator.authProvider.saveTokens({
        access_token: "same-session-late-response",
        token_type: "Bearer",
      }),
    ).rejects.toThrow("session is stale");
    expect(values.has(key)).toBe(false);

    if (!invalidator.authProvider.saveClientInformation) {
      throw new Error("OAuth provider cannot save client information");
    }
    invalidator.authProvider.saveClientInformation({
      client_id: "new-client",
      redirect_uris: [redirectUrl],
    });
    await invalidator.authProvider.saveTokens({
      access_token: "new-access",
      token_type: "Bearer",
    });
    const restarted = JSON.parse(values.get(key) ?? "{}");
    expect(restarted.clientInformation.client_id).toBe("new-client");
    expect(restarted.tokens).toEqual({
      access_token: "new-access",
      token_type: "Bearer",
    });
    expect(restarted.discoveryState).toBeUndefined();
    await stale.close();
    await invalidator.close();
  });

  test("keeps a winning token rotation when a stale refresh invalidates", async () => {
    const key = "concurrent-refresh";
    const redirectUrl = "http://127.0.0.1:45873/callback";
    const values = new Map<string, string>([
      [
        key,
        JSON.stringify({
          redirectUrl,
          clientInformation: {
            client_id: "refresh-client",
            redirect_uris: [redirectUrl],
          },
          tokens: {
            access_token: "access-zero",
            refresh_token: "refresh-zero",
            token_type: "Bearer",
          },
        }),
      ],
    ]);
    const storage = memoryStorage(values);
    const winner = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage,
      interactive: false,
    });
    const loser = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage,
      interactive: false,
    });
    const allScopeLoser = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage,
      interactive: false,
    });
    const staleReader = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage,
      interactive: false,
    });
    if (
      !winner?.authProvider.invalidateCredentials ||
      !loser?.authProvider.invalidateCredentials ||
      !allScopeLoser?.authProvider.invalidateCredentials ||
      !staleReader
    ) {
      throw new Error("Persisted OAuth sessions were not created");
    }

    winner.authProvider.tokens();
    loser.authProvider.tokens();
    await winner.authProvider.saveTokens({
      access_token: "access-one",
      refresh_token: "refresh-one",
      token_type: "Bearer",
    });
    await loser.authProvider.invalidateCredentials("tokens");
    await allScopeLoser.authProvider.invalidateCredentials("all");

    const persisted = JSON.parse(values.get(key) ?? "{}");
    expect(persisted.tokens).toEqual({
      access_token: "access-one",
      refresh_token: "refresh-one",
      token_type: "Bearer",
    });
    expect(await loser.authProvider.tokens()).toEqual(persisted.tokens);
    await winner.authProvider.invalidateCredentials("tokens");
    expect(await staleReader.authProvider.tokens()).toBeUndefined();
    await expect(
      allScopeLoser.authProvider.saveTokens({
        access_token: "resurrected-access",
        token_type: "Bearer",
      }),
    ).rejects.toThrow("token response is stale");
    expect(JSON.parse(values.get(key) ?? "{}").tokens).toBeUndefined();
    await winner.close();
    await loser.close();
    await allScopeLoser.close();
    await staleReader.close();
  });

  test("does not restore scoped client or discovery invalidations", async () => {
    const key = "scoped-invalidation";
    const redirectUrl = "http://127.0.0.1:45874/callback";
    const originalClient = {
      client_id: "old-client",
      redirect_uris: [redirectUrl],
    };
    const originalDiscovery = {
      resourceMetadataUrl: "https://old.example",
      authorizationServerUrl: "https://auth.example",
    };
    const values = new Map<string, string>([
      [
        key,
        JSON.stringify({
          redirectUrl,
          clientInformation: originalClient,
          discoveryState: originalDiscovery,
        }),
      ],
    ]);
    const storage = memoryStorage(values);
    const writer = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage,
      interactive: false,
    });
    const invalidator = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage,
      interactive: false,
    });
    const staleReader = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage,
      interactive: false,
    });
    if (
      !writer?.authProvider.saveClientInformation ||
      !writer.authProvider.saveDiscoveryState ||
      !invalidator?.authProvider.invalidateCredentials ||
      !staleReader
    ) {
      throw new Error("OAuth providers cannot stage and invalidate state");
    }

    writer.authProvider.saveClientInformation(originalClient);
    writer.authProvider.saveDiscoveryState(originalDiscovery);
    await invalidator.authProvider.invalidateCredentials("client");
    await invalidator.authProvider.invalidateCredentials("discovery");
    expect(await staleReader.authProvider.clientInformation()).toBeUndefined();
    expect(await staleReader.authProvider.discoveryState?.()).toBeUndefined();
    await expect(
      writer.authProvider.saveTokens({
        access_token: "late-access",
        token_type: "Bearer",
      }),
    ).rejects.toThrow("protocol state changed");

    const persisted = JSON.parse(values.get(key) ?? "{}");
    expect(persisted.clientInformation).toBeUndefined();
    expect(persisted.discoveryState).toBeUndefined();
    expect(persisted.tokens).toBeUndefined();
    await writer.close();
    await invalidator.close();
    await staleReader.close();
  });

  test("measures token expiry from response receipt before queued storage", async () => {
    const values = new Map<string, string>();
    const readStarted = deferred();
    const releaseRead = deferred();
    let blockRead = false;
    const storage: McpOAuthStorage = {
      get: async (key) => {
        if (blockRead) {
          readStarted.resolve();
          await releaseRead.promise;
        }
        return values.get(key);
      },
      set: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        return values.delete(key);
      },
    };
    const oauth = await createMcpOAuthSessionWithStorage({
      credentialKey: "expiry-before-queue",
      storage,
      interactive: true,
    });
    if (!oauth?.authProvider.saveClientInformation) {
      throw new Error("Interactive OAuth session was not created");
    }
    oauth.authProvider.saveClientInformation({
      client_id: "expiry-client",
      redirect_uris: [String(oauth.authProvider.redirectUrl)],
    });

    blockRead = true;
    const queuedRead = createMcpOAuthSessionWithStorage({
      credentialKey: "expiry-before-queue",
      storage,
      interactive: false,
    });
    await readStarted.promise;
    const tokenSave = oauth.authProvider.saveTokens({
      access_token: "short-lived",
      token_type: "Bearer",
      expires_in: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    blockRead = false;
    releaseRead.resolve();
    await queuedRead;
    await tokenSave;
    expect((await oauth.exportCredentials()).expires_in).toBe(0);
    await oauth.close();
  });

  test("deletes valid JSON with an invalid persisted shape", async () => {
    const invalidStates = [
      { redirectUrl: "not-a-url" },
      {
        redirectUrl: "http://127.0.0.1:45875/callback",
        clientInformation: 1,
      },
      {
        redirectUrl: "http://127.0.0.1:45875/callback",
        clientInformation: { redirect_uris: "not-an-array" },
      },
      {
        redirectUrl: "http://127.0.0.1:45875/callback",
        tokens: { access_token: 1 },
      },
      {
        redirectUrl: "http://127.0.0.1:45875/callback",
        discoveryState: [],
      },
      {
        redirectUrl: "http://127.0.0.1:45875/callback",
        discoveryState: { authorizationServerUrl: 123 },
      },
      {
        redirectUrl: "http://127.0.0.1:45875/callback",
        discoveryState: {
          authorizationServerUrl: "https://auth.example",
          resourceMetadata: {
            resource: "https://mcp.example/mcp",
            scopes_supported: "not-an-array",
          },
          authorizationServerMetadata: {
            authorization_endpoint: "https://auth.example/authorize",
            token_endpoint: "https://auth.example/token",
          },
        },
      },
      {
        redirectUrl: "http://127.0.0.1:45875/callback",
        codeVerifier: "must-remain-transient",
      },
    ];

    for (const [index, invalidState] of invalidStates.entries()) {
      const key = `invalid-shape-${index}`;
      const values = new Map([[key, JSON.stringify(invalidState)]]);
      const oauth = await createMcpOAuthSessionWithStorage({
        credentialKey: key,
        storage: memoryStorage(values),
        interactive: false,
      });
      expect(oauth).toBeUndefined();
      expect(values.has(key)).toBe(false);
    }
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
    const baseStorage = memoryStorage(values);
    const firstReadStarted = deferred();
    let blockFirstRead = true;
    let firstReadAborted = false;
    const storage = {
      get: async (credentialKey: string, signal: AbortSignal) => {
        if (!blockFirstRead) return baseStorage.get(credentialKey);
        blockFirstRead = false;
        firstReadStarted.resolve();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              firstReadAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      set: async (
        credentialKey: string,
        value: string,
        signal: AbortSignal,
      ) => {
        signal.throwIfAborted();
        await baseStorage.set(credentialKey, value);
      },
      delete: async (credentialKey: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        return baseStorage.delete(credentialKey);
      },
    };
    let browserOpenCount = 0;
    const cancelledSubscriber = new AbortController();
    const options = {
      agentId: AGENT_ID,
      storageNamespace: "test-high-level-memory",
      storage,
      serverName: SERVER_NAME,
      serverUrl,
      openBrowser: async (authorizationUrl: string) => {
        browserOpenCount += 1;
        cancelledSubscriber.abort();
        const response = await fetch(authorizationUrl, {
          redirect: "follow",
        });
        await response.text();
      },
    };
    const cancelledFirstAttempt = new AbortController();
    const firstAttempt = authorizeMcpServerWithStorage({
      ...options,
      signal: cancelledFirstAttempt.signal,
    });
    await firstReadStarted.promise;
    cancelledFirstAttempt.abort();
    const immediateRetry = authorizeMcpServerWithStorage(options);
    await expect(firstAttempt).rejects.toBeDefined();
    expect(firstReadAborted).toBe(true);

    const [credentials, duplicateCredentials, cancellation] = await Promise.all(
      [
        immediateRetry,
        authorizeMcpServerWithStorage(options),
        rejectionMessage(
          authorizeMcpServerWithStorage({
            ...options,
            signal: cancelledSubscriber.signal,
          }),
        ),
      ],
    );
    expect(duplicateCredentials).toEqual(credentials);
    expect(cancellation).not.toBe("resolved unexpectedly");
    expect(browserOpenCount).toBe(1);
    expect(credentials.access_token).toBeTruthy();
    expect(credentials.client_id).toBeTruthy();
    expect(credentials.redirect_uri).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    const credentialKey = mcpOAuthCredentialKey(
      AGENT_ID,
      SERVER_NAME,
      serverUrl,
    );
    expect(values.has(credentialKey)).toBe(true);

    const isolated = await createMcpOAuthSessionWithStorage({
      credentialKey: "desktop-other-flow",
      storage: memoryStorage(values),
      interactive: false,
      openBrowser: async () => {},
    });
    expect(isolated).toBeUndefined();

    const persistedOAuth = await createMcpOAuthSessionWithStorage({
      credentialKey,
      storage: baseStorage,
      interactive: false,
      openBrowser: async () => {},
    });
    if (!persistedOAuth)
      throw new Error("OAuth credentials were not persisted");
    expect((await persistedOAuth.exportCredentials()).access_token).toBe(
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

function rejectionMessage(promise: Promise<unknown>): Promise<string> {
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
