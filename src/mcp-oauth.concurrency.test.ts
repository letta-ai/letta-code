import { describe, expect, test } from "bun:test";
import {
  createMcpOAuthSessionWithStorage,
  type McpOAuthStorage,
} from "@/mcp-oauth";

describe("storage-injected MCP OAuth concurrent staging", () => {
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
