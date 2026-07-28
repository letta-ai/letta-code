import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { OAuthRefreshError, type TokenResponse } from "@/auth/oauth";
import { settingsManager } from "@/settings-manager";
import {
  startListenerClient,
  stopListenerClient,
} from "@/websocket/listen-client";
import { __listenerAuthTestUtils } from "@/websocket/listener/auth";
import {
  getOrCreateProcessTransport,
  subscribeListenerConnection,
  TO_SUBSCRIBERS,
} from "@/websocket/listener/connection";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { emitProtocolV2Message } from "@/websocket/listener/protocol-outbound";
import { getActiveRuntime } from "@/websocket/listener/runtime";

type ListenerSettings = Awaited<
  ReturnType<typeof settingsManager.getSettingsWithSecureTokens>
>;

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

describe("listener auth lifecycle", () => {
  const originalHome = process.env.HOME;
  const originalDisableCron = process.env.LETTA_DISABLE_CRON_SCHEDULER;
  const originalDisableMods = process.env.LETTA_DISABLE_MODS;
  const originalApiKey = process.env.LETTA_API_KEY;
  const originalBaseUrl = process.env.LETTA_BASE_URL;
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalUpdateSettings = settingsManager.updateSettings;
  const originalFlush = settingsManager.flush;

  let testHome: string;
  let server: WebSocketServer;
  let wsUrl: string;
  let settings: ListenerSettings;
  let connections: WebSocket[];
  let authorizations: Array<string | undefined>;
  let received: Record<string, unknown>[][];

  const refreshAccessTokenMock = mock(async (): Promise<TokenResponse> => {
    throw new Error("refreshAccessToken not mocked");
  });

  beforeEach(async () => {
    stopListenerClient();
    await settingsManager.reset();
    testHome = await mkdtemp(join(tmpdir(), "letta-listener-auth-"));
    process.env.HOME = testHome;
    process.env.LETTA_DISABLE_CRON_SCHEDULER = "1";
    process.env.LETTA_DISABLE_MODS = "1";
    delete process.env.LETTA_API_KEY;
    delete process.env.LETTA_BASE_URL;
    await settingsManager.initialize();

    settings = {
      ...settingsManager.getSettings(),
      env: { LETTA_API_KEY: "initial-access-token" },
      refreshToken: "refresh-token",
      tokenExpiresAt: Date.now() + 60 * 60 * 1000,
    };
    refreshAccessTokenMock.mockReset();
    __listenerAuthTestUtils.setOAuthDepsForTests({
      LETTA_CLOUD_API_URL: "https://api.letta.com",
      refreshAccessToken: refreshAccessTokenMock,
    });
    settingsManager.getSettingsWithSecureTokens = mock(
      async () => settings,
    ) as typeof settingsManager.getSettingsWithSecureTokens;
    settingsManager.updateSettings = mock((updates) => {
      settings = {
        ...settings,
        ...updates,
        env: { ...settings.env, ...updates.env },
      };
    }) as typeof settingsManager.updateSettings;
    settingsManager.flush = mock(
      async () => {},
    ) as typeof settingsManager.flush;

    connections = [];
    authorizations = [];
    received = [];
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${address.port}`;
    server.on("connection", (socket, request) => {
      const messages: Record<string, unknown>[] = [];
      connections.push(socket);
      authorizations.push(request.headers.authorization);
      received.push(messages);
      socket.on("message", (raw) => {
        messages.push(JSON.parse(String(raw)) as Record<string, unknown>);
      });
    });
  });

  afterEach(async () => {
    stopListenerClient();
    await Promise.all(
      [...server.clients].map(
        (connection) =>
          new Promise<void>((resolve) => {
            if (connection.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            connection.once("close", () => resolve());
            connection.terminate();
          }),
      ),
    );
    server.close();
    __listenerAuthTestUtils.setOAuthDepsForTests(null);
    settingsManager.getSettingsWithSecureTokens =
      originalGetSettingsWithSecureTokens;
    settingsManager.updateSettings = originalUpdateSettings;
    settingsManager.flush = originalFlush;
    await settingsManager.reset();
    await rm(testHome, { recursive: true, force: true });

    process.env.HOME = originalHome;
    if (originalDisableCron === undefined) {
      delete process.env.LETTA_DISABLE_CRON_SCHEDULER;
    } else {
      process.env.LETTA_DISABLE_CRON_SCHEDULER = originalDisableCron;
    }
    if (originalDisableMods === undefined) {
      delete process.env.LETTA_DISABLE_MODS;
    } else {
      process.env.LETTA_DISABLE_MODS = originalDisableMods;
    }
    if (originalApiKey === undefined) {
      delete process.env.LETTA_API_KEY;
    } else {
      process.env.LETTA_API_KEY = originalApiKey;
    }
    if (originalBaseUrl === undefined) {
      delete process.env.LETTA_BASE_URL;
    } else {
      process.env.LETTA_BASE_URL = originalBaseUrl;
    }
  });

  function startClient(overrides: { onError?: (error: Error) => void } = {}) {
    return startListenerClient({
      connectionId: "connection-id",
      wsUrl,
      deviceId: "device-id",
      connectionName: "listener-name",
      onConnected: mock(() => {}),
      onDisconnected: mock(() => {}),
      onNeedsReregister: mock(() => {}),
      onError: overrides.onError ?? mock(() => {}),
    });
  }

  test("refreshes missing credentials on a real socket reconnect", async () => {
    await startClient();
    await waitFor(
      () => connections.length === 1,
      "initial socket did not open",
    );
    expect(authorizations[0]).toBe("Bearer initial-access-token");

    settings = {
      ...settings,
      env: {},
      refreshToken: "refresh-token",
      tokenExpiresAt: undefined,
    };
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "refreshed-access-token",
      refresh_token: "rotated-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
    });

    connections[0]?.close(1000, "reconnect");
    await waitFor(
      () => connections.length === 2,
      "listener did not reconnect with refreshed credentials",
    );

    expect(authorizations[1]).toBe("Bearer refreshed-access-token");
    expect(settings.refreshToken).toBe("rotated-refresh-token");
  });

  test("preserves outbound subscriptions and event sequence across reconnect", async () => {
    await startClient();
    await waitFor(
      () =>
        getActiveRuntime()?.connections.get("connection-id")?.initialized ===
        true,
      "initial listener connection did not initialize",
    );
    const runtime = getActiveRuntime();
    expect(runtime).not.toBeNull();
    if (!runtime) return;

    const scope = { agent_id: "agent-1", conversation_id: "conv-1" };
    const conversationRuntime = getOrCreateScopedRuntime(
      runtime,
      scope.agent_id,
      scope.conversation_id,
    );
    subscribeListenerConnection(runtime, "connection-id", scope);
    emitProtocolV2Message(
      getOrCreateProcessTransport(runtime),
      conversationRuntime,
      { type: "crons_updated", timestamp: 1 } as never,
      scope,
      TO_SUBSCRIBERS,
    );
    await waitFor(
      () =>
        received[0]?.some((message) => message.type === "crons_updated") ===
        true,
      "initial scoped event was not delivered",
    );
    const eventSeqBeforeReconnect =
      runtime.connections.get("connection-id")?.eventSeqCounter ?? 0;

    connections[0]?.close(1000, "reconnect");
    await waitFor(
      () =>
        connections.length === 2 &&
        runtime.connections.get("connection-id")?.initialized === true,
      "listener did not reconnect",
    );

    const reconnected = runtime.connections.get("connection-id");
    expect(reconnected?.subscriptions).toEqual(
      new Set(["agent:agent-1::conversation:conv-1"]),
    );
    expect(reconnected?.eventSeqCounter).toBeGreaterThanOrEqual(
      eventSeqBeforeReconnect,
    );

    const resumedRuntime = getOrCreateScopedRuntime(
      runtime,
      scope.agent_id,
      scope.conversation_id,
    );
    emitProtocolV2Message(
      getOrCreateProcessTransport(runtime),
      resumedRuntime,
      { type: "crons_updated", timestamp: 2 } as never,
      scope,
      TO_SUBSCRIBERS,
    );
    await waitFor(
      () =>
        received[1]?.some((message) => message.type === "crons_updated") ===
        true,
      "post-reconnect scoped event was not delivered",
    );
    const resumedEvent = received[1]?.find(
      (message) => message.type === "crons_updated",
    );
    expect(resumedEvent?.event_seq).toBeGreaterThan(eventSeqBeforeReconnect);
  });

  test("does not create a socket after stop wins an in-flight refresh", async () => {
    settings = {
      ...settings,
      env: {},
      refreshToken: "refresh-token",
      tokenExpiresAt: undefined,
    };
    let resolveRefresh: ((tokens: TokenResponse) => void) | undefined;
    refreshAccessTokenMock.mockImplementation(
      () =>
        new Promise<TokenResponse>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const starting = startClient();
    await waitFor(
      () => refreshAccessTokenMock.mock.calls.length === 1,
      "listener did not begin refreshing credentials",
    );

    stopListenerClient();
    resolveRefresh?.({
      access_token: "late-access-token",
      refresh_token: "late-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
    });
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(connections).toHaveLength(0);
  });

  test("retries a transient refresh failure instead of terminating", async () => {
    const onError = mock(() => {});
    await startClient({ onError });
    await waitFor(
      () => connections.length === 1,
      "initial socket did not open",
    );

    settings = {
      ...settings,
      env: { LETTA_API_KEY: "expired-access-token" },
      tokenExpiresAt: Date.now() - 1,
    };
    refreshAccessTokenMock
      .mockRejectedValueOnce(
        new OAuthRefreshError("auth service unavailable", {
          retryable: true,
          status: 503,
        }),
      )
      .mockResolvedValueOnce({
        access_token: "recovered-access-token",
        refresh_token: "recovered-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      });

    connections[0]?.close(1000, "reconnect");
    await waitFor(
      () => connections.length === 2,
      "listener did not retry the transient refresh failure",
    );

    expect(authorizations[1]).toBe("Bearer recovered-access-token");
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });
});
