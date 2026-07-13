import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { DeviceCodeResponse, TokenResponse } from "@/auth/oauth";
import { settingsManager } from "@/settings-manager";
import {
  __listenClientTestUtils,
  startListenerClient,
  stopListenerClient,
} from "@/websocket/listen-client";
import { __listenerAuthTestUtils } from "./auth";

type ListenerTestSettings = Partial<
  Awaited<ReturnType<typeof settingsManager.getSettingsWithSecureTokens>>
> & {
  env?: Record<string, string>;
  refreshToken?: string;
  tokenExpiresAt?: number;
};

type SocketRequest = {
  url: string;
  authorization: string;
};

class FakeListenerSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: unknown[] = [];
  readonly send = mock((payload: unknown) => {
    this.sent.push(payload);
  });
  readonly close = mock(() => {
    this.closeFromServer(1000);
  });
  readonly terminate = mock(() => {
    this.closeFromServer(1006);
  });

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  closeFromServer(code: number, reason = ""): void {
    if (this.readyState === WebSocket.CLOSED) {
      return;
    }
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) {
      return;
    }
    await nextTurn();
  }
  throw new Error(message);
}

describe("listener reconnect auth", () => {
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalUpdateSettings = settingsManager.updateSettings;
  const originalFlush = settingsManager.flush;
  const originalGetOrCreateDeviceId = settingsManager.getOrCreateDeviceId;
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalApiKey = process.env.LETTA_API_KEY;
  const originalBaseUrl = process.env.LETTA_BASE_URL;
  const originalDisableCron = process.env.LETTA_DISABLE_CRON_SCHEDULER;

  let settingsState: ListenerTestSettings;
  let sockets: FakeListenerSocket[];
  let socketRequests: SocketRequest[];

  const refreshAccessTokenMock = mock(async (): Promise<TokenResponse> => {
    throw new Error("refreshAccessToken not mocked");
  });
  const requestDeviceCodeMock = mock(async (): Promise<DeviceCodeResponse> => {
    throw new Error("requestDeviceCode not mocked");
  });
  const pollForTokenMock = mock(async (): Promise<TokenResponse> => {
    throw new Error("pollForToken not mocked");
  });
  const updateSettingsMock = mock(() => {});
  const flushMock = mock(async () => {});

  beforeEach(() => {
    sockets = [];
    socketRequests = [];
    settingsState = {
      env: {
        LETTA_API_KEY: "initial-access-token",
      },
      refreshToken: "refresh-token",
      tokenExpiresAt: Date.now() + 60 * 60 * 1000,
    };

    refreshAccessTokenMock.mockReset();
    requestDeviceCodeMock.mockReset();
    pollForTokenMock.mockReset();
    updateSettingsMock.mockReset();
    flushMock.mockReset();

    __listenerAuthTestUtils.setOAuthDepsForTests({
      LETTA_CLOUD_API_URL: "https://api.letta.com",
      refreshAccessToken: refreshAccessTokenMock,
      requestDeviceCode: requestDeviceCodeMock,
      pollForToken: pollForTokenMock,
    });
    __listenerAuthTestUtils.clearInFlightRefreshesForTests();

    settingsManager.getSettingsWithSecureTokens = mock(
      async () =>
        settingsState as Awaited<
          ReturnType<typeof settingsManager.getSettingsWithSecureTokens>
        >,
    ) as unknown as typeof settingsManager.getSettingsWithSecureTokens;
    settingsManager.updateSettings =
      updateSettingsMock as typeof settingsManager.updateSettings;
    settingsManager.flush = flushMock as typeof settingsManager.flush;
    settingsManager.getOrCreateDeviceId = mock(
      () => "device-id-for-telemetry",
    ) as typeof settingsManager.getOrCreateDeviceId;

    __listenClientTestUtils.setListenerWebSocketFactoryForTests(
      (url, options) => {
        const socket = new FakeListenerSocket();
        socketRequests.push({
          url,
          authorization: options.headers.Authorization,
        });
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    );

    delete process.env.LETTA_API_KEY;
    delete process.env.LETTA_BASE_URL;
    process.env.LETTA_DISABLE_CRON_SCHEDULER = "1";

    console.log = mock(() => {}) as typeof console.log;
    console.warn = mock(() => {}) as typeof console.warn;
  });

  afterEach(() => {
    stopListenerClient();
    __listenClientTestUtils.setListenerWebSocketFactoryForTests(null);
    __listenClientTestUtils.setActiveRuntime(null);
    __listenerAuthTestUtils.setOAuthDepsForTests(null);
    __listenerAuthTestUtils.clearInFlightRefreshesForTests();

    settingsManager.getSettingsWithSecureTokens =
      originalGetSettingsWithSecureTokens;
    settingsManager.updateSettings = originalUpdateSettings;
    settingsManager.flush = originalFlush;
    settingsManager.getOrCreateDeviceId = originalGetOrCreateDeviceId;

    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;

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

    if (originalDisableCron === undefined) {
      delete process.env.LETTA_DISABLE_CRON_SCHEDULER;
    } else {
      process.env.LETTA_DISABLE_CRON_SCHEDULER = originalDisableCron;
    }
  });

  function startClient(
    overrides: Partial<Parameters<typeof startListenerClient>[0]> = {},
  ) {
    return startListenerClient({
      connectionId: "conn-1",
      wsUrl: "wss://api.letta.com/v1/environments/ws/conn-1",
      deviceId: "device-1",
      connectionName: "listener-env",
      onConnected: mock(() => {}),
      onDisconnected: mock(() => {}),
      onNeedsReregister: mock(() => {}),
      onError: mock((_error: Error) => {}),
      ...overrides,
    });
  }

  test("refreshes missing saved access credentials during ordinary reconnect", async () => {
    const onError = mock((_error: Error) => {});
    const onNeedsReregister = mock(() => {});

    await startClient({ onError, onNeedsReregister });
    expect(socketRequests).toHaveLength(1);
    expect(socketRequests[0]?.authorization).toBe(
      "Bearer initial-access-token",
    );

    sockets[0]?.open();
    await nextTurn();

    settingsState = {
      env: {},
      refreshToken: "refresh-token",
    };
    refreshAccessTokenMock.mockImplementation(async () => ({
      access_token: "refreshed-access-token",
      refresh_token: "rotated-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
    }));

    sockets[0]?.closeFromServer(1000, "ordinary close");

    await waitFor(
      () => socketRequests.length === 2,
      "listener did not reconnect with refreshed credentials",
    );

    expect(refreshAccessTokenMock).toHaveBeenCalledWith(
      "refresh-token",
      "device-1",
      "listener-env",
    );
    expect(updateSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { LETTA_API_KEY: "refreshed-access-token" },
        refreshToken: "rotated-refresh-token",
        tokenExpiresAt: expect.any(Number),
      }),
    );
    expect(flushMock).toHaveBeenCalledTimes(1);
    expect(socketRequests[1]?.authorization).toBe(
      "Bearer refreshed-access-token",
    );
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
    expect(onNeedsReregister).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test("routes missing credentials after abnormal reconnect into re-registration", async () => {
    const onError = mock((_error: Error) => {});
    const onNeedsReregister = mock(() => {});

    await startClient({ onError, onNeedsReregister });
    sockets[0]?.open();
    await nextTurn();

    settingsState = {
      env: {},
    };

    sockets[0]?.closeFromServer(1006, "abnormal close");

    await waitFor(
      () => onNeedsReregister.mock.calls.length === 1,
      "listener did not request re-registration for missing credentials",
    );

    expect(socketRequests).toHaveLength(1);
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test("refreshes expired saved access credentials during reconnect", async () => {
    await startClient();
    sockets[0]?.open();
    await nextTurn();

    settingsState = {
      env: {
        LETTA_API_KEY: "expired-access-token",
      },
      refreshToken: "refresh-token",
      tokenExpiresAt: Date.now() - 1000,
    };
    refreshAccessTokenMock.mockImplementation(async () => ({
      access_token: "fresh-expired-token",
      refresh_token: "fresh-rotated-refresh-token",
      token_type: "Bearer",
      expires_in: 7200,
    }));

    sockets[0]?.closeFromServer(1000, "expired token close");

    await waitFor(
      () => socketRequests.length === 2,
      "listener did not reconnect after refreshing expired credentials",
    );

    expect(socketRequests[1]?.authorization).toBe("Bearer fresh-expired-token");
    expect(updateSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { LETTA_API_KEY: "fresh-expired-token" },
        refreshToken: "fresh-rotated-refresh-token",
        tokenExpiresAt: expect.any(Number),
      }),
    );
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
  });

  test("reports revoked refresh credentials once without retrying silently", async () => {
    const onError = mock((_error: Error) => {});
    const onNeedsReregister = mock(() => {});

    await startClient({ onError, onNeedsReregister });
    sockets[0]?.open();
    await nextTurn();

    settingsState = {
      env: {
        LETTA_API_KEY: "expired-access-token",
      },
      refreshToken: "revoked-refresh-token",
      tokenExpiresAt: Date.now() - 1000,
    };
    refreshAccessTokenMock.mockRejectedValue(new Error("invalid_grant"));

    sockets[0]?.closeFromServer(1000, "revoked refresh close");

    await waitFor(
      () => onError.mock.calls.length === 1,
      "listener did not surface revoked refresh credentials",
    );

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(socketRequests).toHaveLength(1);
    expect(onNeedsReregister).not.toHaveBeenCalled();
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
    const error = onError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Saved Letta Cloud credentials could not be refreshed: invalid_grant",
    );
    expect((error as Error).message).toContain("Run letta server again");
  });
});
