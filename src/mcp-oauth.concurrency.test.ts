import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import {
  createMcpOAuthSessionWithStorage,
  type McpOAuthStorage,
} from "@/mcp-oauth";
import { authorizeMcpServerWithStorage } from "@/mcp-oauth-public";

describe("storage-injected MCP OAuth concurrent staging", () => {
  test("rejects foreign request targets without ending the callback", async () => {
    const oauth = await createMcpOAuthSessionWithStorage({
      credentialKey: "malformed-callback-target",
      storage: memoryStorage(new Map()),
      interactive: true,
    });
    if (!oauth?.waitForAuthorizationCode || !oauth.authProvider.state) {
      throw new Error("Interactive OAuth callback was not created");
    }
    const expectedState = await oauth.authProvider.state();
    const redirectUrl = new URL(String(oauth.authProvider.redirectUrl));
    const authorizationCode = oauth.waitForAuthorizationCode();

    const malformed = await rawHttpRequest(Number(redirectUrl.port), "//[");
    expect(malformed).toContain(" 400 ");
    const absolute = await rawHttpRequest(
      Number(redirectUrl.port),
      `http://attacker.invalid/callback?code=foreign-code&state=${encodeURIComponent(expectedState)}`,
    );
    expect(absolute).toContain(" 400 ");
    const valid = await fetch(
      `${redirectUrl.toString()}?code=expected-code&state=${encodeURIComponent(expectedState)}`,
    );
    expect(valid.status).toBe(200);
    await expect(authorizationCode).resolves.toBe("expected-code");
    await oauth.close();
  });

  test("aborts a public authorization while the MCP server is hung", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Hung MCP test server did not bind");
    }
    const controller = new AbortController();
    const authorization = authorizeMcpServerWithStorage({
      agentId: "agent-abort",
      storageNamespace: "test-hung-server",
      storage: memoryStorage(new Map()),
      serverName: "Hung MCP",
      serverUrl: `http://127.0.0.1:${address.port}/mcp`,
      openBrowser: async () => {},
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 25);
    const outcome = await Promise.race([
      authorization.then(
        () => "resolved",
        () => "rejected",
      ),
      Bun.sleep(500).then(() => "timed-out"),
    ]);
    expect(outcome).toBe("rejected");
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("aborts while the storage-backed session is still loading", async () => {
    let rejectRead = (_error: Error) => {};
    const blockedRead = new Promise<never>((_resolve, reject) => {
      rejectRead = reject;
    });
    const controller = new AbortController();
    const storage: McpOAuthStorage = {
      get: async () => blockedRead,
      set: async () => {},
      delete: async () => false,
    };
    const authorization = authorizeMcpServerWithStorage({
      agentId: "agent-delayed-storage",
      storageNamespace: "test-delayed-storage",
      storage,
      serverName: "Delayed storage MCP",
      serverUrl: "http://127.0.0.1:1/mcp",
      openBrowser: async () => {},
      signal: controller.signal,
    });
    controller.abort();
    await expect(authorization).rejects.toBeDefined();
    rejectRead(new Error("late storage read failed"));
    await Bun.sleep(10);
  });

  test("isolates identical credential keys across storage backends", async () => {
    const key = "same-key-different-backends";
    const redirectUrl = "http://127.0.0.1:45880/callback";
    const persisted = (suffix: string) =>
      JSON.stringify({
        redirectUrl,
        clientInformation: {
          client_id: `client-${suffix}`,
          redirect_uris: [redirectUrl],
        },
        tokens: {
          access_token: `access-${suffix}`,
          refresh_token: `refresh-${suffix}`,
          token_type: "Bearer",
        },
      });
    const storageA = memoryStorage(new Map([[key, persisted("a")]]));
    const storageB = memoryStorage(new Map([[key, persisted("b")]]));
    const oauthA = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage: storageA,
      interactive: false,
    });
    const oauthB = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage: storageB,
      interactive: false,
    });
    if (!oauthA || !oauthB) throw new Error("OAuth sessions were not created");

    expect((await oauthA.authProvider.tokens())?.access_token).toBe("access-a");
    expect((await oauthB.authProvider.tokens())?.access_token).toBe("access-b");
    expect((await oauthA.exportCredentials()).refresh_token).toBe("refresh-a");
    expect((await oauthB.exportCredentials()).refresh_token).toBe("refresh-b");
    await oauthA.close();
    await oauthB.close();
    expect(() => oauthA.authProvider.tokens()).toThrow("session is closed");
    expect(() => oauthB.authProvider.tokens()).toThrow("session is closed");
  });

  test("scrubs local credentials when closed during a pending write", async () => {
    const key = "close-during-write";
    const values = new Map<string, string>();
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const storage = blockingStorage(
      values,
      () => true,
      writeStarted.resolve,
      releaseWrite.promise,
    );
    const oauth = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage,
      interactive: true,
    });
    if (!oauth?.authProvider.saveClientInformation) {
      throw new Error("OAuth provider cannot save client information");
    }
    oauth.authProvider.saveClientInformation({
      client_id: "secret-client-after-close",
      redirect_uris: [String(oauth.authProvider.redirectUrl)],
    });
    const saving = oauth.authProvider.saveTokens({
      access_token: "secret-access-after-close",
      token_type: "Bearer",
    });
    await writeStarted.promise;
    const closing = oauth.close();
    releaseWrite.resolve();
    await Promise.all([saving, closing]);

    const retainedProviderState = JSON.stringify(oauth.authProvider);
    expect(retainedProviderState).not.toContain("secret-client-after-close");
    expect(retainedProviderState).not.toContain("secret-access-after-close");
  });

  test("preserves state staged while scoped invalidations are writing", async () => {
    const key = "staged-during-invalidation";
    const redirectUrl = "http://127.0.0.1:45876/callback";
    const values = new Map<string, string>([
      [
        key,
        JSON.stringify({
          redirectUrl,
          clientInformation: {
            client_id: "old-client",
            redirect_uris: [redirectUrl],
          },
          discoveryState: {
            authorizationServerUrl: "https://old-auth.example",
          },
        }),
      ],
    ]);
    const writeStarted = deferred();
    const releaseWrite = deferred();
    let blockNextWrite = true;
    const storage = blockingStorage(
      values,
      () => blockNextWrite,
      () => {
        blockNextWrite = false;
        writeStarted.resolve();
      },
      releaseWrite.promise,
    );
    const oauth = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage,
      interactive: false,
    });
    if (
      !oauth?.authProvider.invalidateCredentials ||
      !oauth.authProvider.saveClientInformation ||
      !oauth.authProvider.saveDiscoveryState
    ) {
      throw new Error("OAuth provider cannot update protocol state");
    }

    oauth.authProvider.clientInformation();
    const invalidation = oauth.authProvider.invalidateCredentials("client");
    await writeStarted.promise;
    oauth.authProvider.saveClientInformation({
      client_id: "new-client",
      redirect_uris: [redirectUrl],
    });
    oauth.authProvider.saveDiscoveryState({
      authorizationServerUrl: "https://new-auth.example",
    });
    releaseWrite.resolve();
    await invalidation;

    expect((await oauth.authProvider.clientInformation())?.client_id).toBe(
      "new-client",
    );
    expect(
      (await oauth.authProvider.discoveryState?.())?.authorizationServerUrl,
    ).toBe("https://new-auth.example");
    await oauth.authProvider.saveTokens({
      access_token: "new-access",
      token_type: "Bearer",
    });
    const persisted = JSON.parse(values.get(key) ?? "{}");
    expect(persisted.clientInformation.client_id).toBe("new-client");
    expect(persisted.discoveryState.authorizationServerUrl).toBe(
      "https://new-auth.example",
    );
    await oauth.close();
  });

  test("preserves newer state staged while a token write is pending", async () => {
    const key = "staged-during-token-write";
    const values = new Map<string, string>();
    const writeStarted = deferred();
    const releaseWrite = deferred();
    let blockNextWrite = true;
    const storage = blockingStorage(
      values,
      () => blockNextWrite,
      () => {
        blockNextWrite = false;
        writeStarted.resolve();
      },
      releaseWrite.promise,
    );
    const oauth = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage,
      interactive: true,
    });
    if (
      !oauth?.authProvider.saveClientInformation ||
      !oauth.authProvider.saveDiscoveryState
    ) {
      throw new Error("OAuth provider cannot update protocol state");
    }
    const redirectUrl = String(oauth.authProvider.redirectUrl);
    oauth.authProvider.saveClientInformation({
      client_id: "client-a",
      redirect_uris: [redirectUrl],
    });
    oauth.authProvider.saveDiscoveryState({
      authorizationServerUrl: "https://auth-a.example",
    });
    const firstSave = oauth.authProvider.saveTokens({
      access_token: "access-a",
      token_type: "Bearer",
    });
    await writeStarted.promise;
    oauth.authProvider.saveClientInformation({
      client_id: "client-b",
      redirect_uris: [redirectUrl],
    });
    oauth.authProvider.saveDiscoveryState({
      authorizationServerUrl: "https://auth-b.example",
    });
    releaseWrite.resolve();
    await firstSave;

    expect((await oauth.authProvider.clientInformation())?.client_id).toBe(
      "client-b",
    );
    expect(
      (await oauth.authProvider.discoveryState?.())?.authorizationServerUrl,
    ).toBe("https://auth-b.example");
    oauth.authProvider.tokens();
    await oauth.authProvider.saveTokens({
      access_token: "access-b",
      token_type: "Bearer",
    });
    const persisted = JSON.parse(values.get(key) ?? "{}");
    expect(persisted.clientInformation.client_id).toBe("client-b");
    expect(persisted.discoveryState.authorizationServerUrl).toBe(
      "https://auth-b.example",
    );
    await oauth.close();
  });

  test("drops stale pending state when scoped invalidation loses", async () => {
    const key = "losing-scoped-invalidation";
    const values = new Map<string, string>();
    const storage = memoryStorage(values);
    const loser = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage,
      interactive: true,
    });
    const winner = await createMcpOAuthSessionWithStorage({
      credentialKey: key,
      storage,
      interactive: true,
    });
    if (
      !loser?.authProvider.saveClientInformation ||
      !loser.authProvider.saveDiscoveryState ||
      !loser.authProvider.invalidateCredentials ||
      !winner?.authProvider.saveClientInformation ||
      !winner.authProvider.saveDiscoveryState
    ) {
      throw new Error("OAuth providers cannot update protocol state");
    }

    loser.authProvider.saveClientInformation({
      client_id: "stale-pending",
      redirect_uris: [String(loser.authProvider.redirectUrl)],
    });
    loser.authProvider.saveDiscoveryState({
      authorizationServerUrl: "https://stale-auth.example",
    });
    winner.authProvider.saveClientInformation({
      client_id: "winner",
      redirect_uris: [String(winner.authProvider.redirectUrl)],
    });
    winner.authProvider.saveDiscoveryState({
      authorizationServerUrl: "https://winner-auth.example",
    });
    await winner.authProvider.saveTokens({
      access_token: "winner-access",
      refresh_token: "winner-refresh",
      token_type: "Bearer",
    });

    await loser.authProvider.invalidateCredentials("client");
    await loser.authProvider.invalidateCredentials("discovery");
    expect((await loser.authProvider.clientInformation())?.client_id).toBe(
      "winner",
    );
    expect(
      (await loser.authProvider.discoveryState?.())?.authorizationServerUrl,
    ).toBe("https://winner-auth.example");
    loser.authProvider.tokens();
    await loser.authProvider.saveTokens({
      access_token: "refreshed-access",
      token_type: "Bearer",
    });

    const persisted = JSON.parse(values.get(key) ?? "{}");
    expect(persisted.clientInformation.client_id).toBe("winner");
    expect(persisted.discoveryState.authorizationServerUrl).toBe(
      "https://winner-auth.example",
    );
    expect(persisted.tokens.refresh_token).toBe("winner-refresh");
    await loser.close();
    await winner.close();
  });
});

function blockingStorage(
  values: Map<string, string>,
  shouldBlock: () => boolean,
  onBlocked: () => void,
  release: Promise<void>,
): McpOAuthStorage {
  return {
    get: async (credentialKey) => values.get(credentialKey),
    set: async (credentialKey, value) => {
      if (shouldBlock()) {
        onBlocked();
        await release;
      }
      values.set(credentialKey, value);
    },
    delete: async (credentialKey) => values.delete(credentialKey),
  };
}

function memoryStorage(values: Map<string, string>): McpOAuthStorage {
  return {
    get: async (credentialKey) => values.get(credentialKey),
    set: async (credentialKey, value) => {
      values.set(credentialKey, value);
    },
    delete: async (credentialKey) => values.delete(credentialKey),
  };
}

function rawHttpRequest(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("connect", () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
    });
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
