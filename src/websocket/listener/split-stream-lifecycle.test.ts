import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { settingsManager } from "@/settings-manager";
import type { ControlRequest } from "@/types/protocol_v2";
import {
  startListenerClient,
  stopListenerClient,
} from "@/websocket/listen-client";
import {
  requestApprovalOverWS,
  resolvePendingApprovalResolver,
} from "@/websocket/listener/approval";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import {
  handleListenerSocketOpenFailure,
  retainRejectedStreamErrorSink,
} from "@/websocket/listener/split-stream-lifecycle";

type ListenerSettings = Awaited<
  ReturnType<typeof settingsManager.getSettingsWithSecureTokens>
>;

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

describe("split stream listener lifecycle", () => {
  const originalHome = process.env.HOME;
  const originalDisableCron = process.env.LETTA_DISABLE_CRON_SCHEDULER;
  const originalDisableMods = process.env.LETTA_DISABLE_MODS;
  const originalApiKey = process.env.LETTA_API_KEY;
  const originalBaseUrl = process.env.LETTA_BASE_URL;
  const originalStreamOpenTimeout =
    process.env.LETTA_LISTENER_STREAM_OPEN_TIMEOUT_MS;
  const originalRetryDuration = process.env.LETTA_LISTENER_RETRY_DURATION_MS;
  const originalInitialRetryDelay =
    process.env.LETTA_LISTENER_INITIAL_RETRY_DELAY_MS;
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalUpdateSettings = settingsManager.updateSettings;
  const originalFlush = settingsManager.flush;

  let testHome: string;
  let settings: ListenerSettings;
  let httpServer: HttpServer;
  let server: WebSocketServer;
  let wsUrl: string;
  let connections: WebSocket[];
  let connectionChannels: Array<string | null>;
  let connectionUrls: URL[];
  let receivedFrames: unknown[][];
  let hangNextStreamUpgrade: boolean;
  let rejectNextStreamUpgrade: boolean;
  let streamUpgradeAttempts: number;
  let stalledUpgradeSockets: Set<Duplex>;

  beforeEach(async () => {
    stopListenerClient();
    await settingsManager.reset();
    testHome = await mkdtemp(join(tmpdir(), "letta-split-stream-"));
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
    connectionChannels = [];
    connectionUrls = [];
    receivedFrames = [];
    hangNextStreamUpgrade = false;
    rejectNextStreamUpgrade = false;
    streamUpgradeAttempts = 0;
    stalledUpgradeSockets = new Set();
    server = new WebSocketServer({ noServer: true });
    httpServer = createServer();
    httpServer.on("upgrade", (request, socket, head) => {
      const requestUrl = new URL(request.url ?? "/", "ws://127.0.0.1");
      const channel = requestUrl.searchParams.get("channel");
      if (channel === "stream") {
        streamUpgradeAttempts += 1;
        if (hangNextStreamUpgrade) {
          hangNextStreamUpgrade = false;
          stalledUpgradeSockets.add(socket);
          socket.once("close", () => stalledUpgradeSockets.delete(socket));
          socket.on("error", () => {});
          return;
        }
        if (rejectNextStreamUpgrade) {
          rejectNextStreamUpgrade = false;
          socket.end(
            "HTTP/1.1 503 Service Unavailable\r\n" +
              "Connection: close\r\n" +
              "Content-Length: 0\r\n\r\n",
          );
          return;
        }
      }
      server.handleUpgrade(request, socket, head, (upgradedSocket) => {
        server.emit("connection", upgradedSocket, request);
      });
    });
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", resolve),
    );
    const address = httpServer.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${address.port}`;
    server.on("connection", (socket, request) => {
      const index = connections.length;
      connections.push(socket);
      const requestUrl = new URL(request.url ?? "/", "ws://127.0.0.1");
      connectionUrls.push(requestUrl);
      connectionChannels.push(requestUrl.searchParams.get("channel"));
      receivedFrames[index] = [];
      socket.on("message", (data) => {
        receivedFrames[index]?.push(JSON.parse(data.toString()) as unknown);
      });
    });
  });

  test("a rejected stream absorbs an error delivered after close", () => {
    const socket = new EventEmitter();
    retainRejectedStreamErrorSink(socket as unknown as WebSocket);

    socket.emit("close");
    expect(() =>
      socket.emit("error", new Error("late stream error")),
    ).not.toThrow();
  });

  afterEach(async () => {
    stopListenerClient();
    for (const socket of stalledUpgradeSockets) socket.destroy();
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
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 100);
      server.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 100);
      httpServer.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });

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
    for (const [name, value] of [
      ["LETTA_LISTENER_RETRY_DURATION_MS", originalRetryDuration],
      ["LETTA_LISTENER_INITIAL_RETRY_DELAY_MS", originalInitialRetryDelay],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (originalStreamOpenTimeout === undefined) {
      delete process.env.LETTA_LISTENER_STREAM_OPEN_TIMEOUT_MS;
    } else {
      process.env.LETTA_LISTENER_STREAM_OPEN_TIMEOUT_MS =
        originalStreamOpenTimeout;
    }
  });

  function startClient(overrides: {
    onConnected?: (connectionId?: string) => void;
    onDisconnected?: () => void;
    onNeedsReregister?: () => void;
    onError?: (error: Error) => void;
    supportsPairedListenerGenerations?: boolean;
  }) {
    return startListenerClient({
      connectionId: "connection-id",
      wsUrl,
      deviceId: "device-id",
      connectionName: "listener-name",
      supportsSplitStatusChannels: true,
      supportsPairedListenerGenerations:
        overrides.supportsPairedListenerGenerations,
      onConnected: overrides.onConnected ?? mock(() => {}),
      onDisconnected: overrides.onDisconnected ?? mock(() => {}),
      onNeedsReregister: overrides.onNeedsReregister ?? mock(() => {}),
      onError: overrides.onError ?? mock(() => {}),
    });
  }

  function makeControlRequest(requestId: string): ControlRequest {
    return {
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: {},
        tool_call_id: requestId.replace("perm-", "call-"),
        permission_suggestions: [],
        blocked_path: null,
      },
    };
  }

  function countConnectionsForChannel(channel: string): number {
    return connectionChannels.filter((value) => value === channel).length;
  }

  function lastConnectionIndexForChannel(channel: string): number {
    for (let index = connectionChannels.length - 1; index >= 0; index -= 1) {
      if (connectionChannels[index] === channel) return index;
    }
    return -1;
  }

  function acceptConnection(
    index: number,
    overrides?: {
      generation?: string;
      attempt?: number;
      incarnation?: string;
    },
  ): void {
    const url = connectionUrls[index];
    const socket = connections[index];
    if (!url || !socket) throw new Error("listener connection is missing");
    socket.send(
      JSON.stringify({
        type: "listener_ready",
        connection_generation:
          overrides?.generation ?? url.searchParams.get("connectionGeneration"),
        connection_attempt:
          overrides?.attempt ??
          Number(url.searchParams.get("connectionAttempt")),
        ...(overrides?.incarnation
          ? { connection_incarnation: overrides.incarnation }
          : {}),
      }),
    );
  }

  test("paired startup waits for exact control and stream acceptance", async () => {
    const onConnected = mock(() => {});
    await startClient({
      onConnected,
      supportsPairedListenerGenerations: true,
    });
    await waitFor(
      () => countConnectionsForChannel("control") === 1,
      "paired control socket did not open",
    );
    expect(countConnectionsForChannel("stream")).toBe(0);
    expect(onConnected).not.toHaveBeenCalled();
    expect(receivedFrames[0]).toEqual([]);

    const controlIndex = lastConnectionIndexForChannel("control");
    const controlUrl = connectionUrls[controlIndex];
    expect(controlUrl?.searchParams.get("connectionGeneration")).toBeTruthy();
    expect(controlUrl?.searchParams.get("connectionAttempt")).toBe("1");
    acceptConnection(controlIndex, { incarnation: "control-incarnation-1" });

    await waitFor(
      () => countConnectionsForChannel("stream") === 1,
      "paired stream socket did not open after control acceptance",
    );
    const streamIndex = lastConnectionIndexForChannel("stream");
    expect(
      connectionUrls[streamIndex]?.searchParams.get("connectionGeneration"),
    ).toBe(controlUrl?.searchParams.get("connectionGeneration"));
    expect(
      connectionUrls[streamIndex]?.searchParams.get("connectionAttempt"),
    ).toBe("1");
    expect(
      connectionUrls[streamIndex]?.searchParams.get("connectionIncarnation"),
    ).toBe("control-incarnation-1");
    expect(onConnected).not.toHaveBeenCalled();
    expect(receivedFrames[controlIndex]).toEqual([]);
    expect(receivedFrames[streamIndex]).toEqual([]);
    connections[controlIndex]?.send(
      JSON.stringify({ type: "app_server_info", request_id: "during-startup" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(receivedFrames[controlIndex]).toEqual([]);

    acceptConnection(streamIndex, { incarnation: "control-incarnation-1" });
    await waitFor(
      () => onConnected.mock.calls.length === 1,
      "listener runtime did not open after both sockets were accepted",
    );
    await waitFor(
      () =>
        receivedFrames[controlIndex]?.some(
          (frame) =>
            (frame as { request_id?: string }).request_id === "during-startup",
        ) ?? false,
      "control frame buffered during startup was not handled",
    );
  });

  test("stream acceptance must echo the control-issued incarnation", async () => {
    const onConnected = mock(() => {});
    await startClient({
      onConnected,
      supportsPairedListenerGenerations: true,
    });
    await waitFor(
      () => countConnectionsForChannel("control") === 1,
      "paired control socket did not open",
    );
    const controlIndex = lastConnectionIndexForChannel("control");
    acceptConnection(controlIndex, { incarnation: "control-incarnation-1" });
    await waitFor(
      () => countConnectionsForChannel("stream") === 1,
      "paired stream socket did not open",
    );
    const streamIndex = lastConnectionIndexForChannel("stream");
    expect(
      connectionUrls[streamIndex]?.searchParams.get("connectionIncarnation"),
    ).toBe("control-incarnation-1");

    acceptConnection(streamIndex, { incarnation: "replacement-incarnation" });

    await waitFor(
      () => countConnectionsForChannel("control") === 2,
      "listener did not reconnect after mismatched stream incarnation",
    );
    expect(onConnected).not.toHaveBeenCalled();
  });

  test("old Cloud acknowledgements without an incarnation remain compatible", async () => {
    const onConnected = mock(() => {});
    await startClient({
      onConnected,
      supportsPairedListenerGenerations: true,
    });
    await waitFor(
      () => countConnectionsForChannel("control") === 1,
      "paired control socket did not open",
    );
    acceptConnection(lastConnectionIndexForChannel("control"));
    await waitFor(
      () => countConnectionsForChannel("stream") === 1,
      "legacy paired stream socket did not open",
    );
    const streamIndex = lastConnectionIndexForChannel("stream");
    expect(
      connectionUrls[streamIndex]?.searchParams.has("connectionIncarnation"),
    ).toBe(false);
    acceptConnection(streamIndex);
    await waitFor(
      () => onConnected.mock.calls.length === 1,
      "legacy pair did not become active",
    );
  });

  test("a new control ack with an old stream ack rejects the pair and reconnects", async () => {
    // Mixed rollout: no same-version pod affinity, so control can land on a
    // new pod that issues an incarnation while stream lands on an old pod
    // that omits it. The pair must never start the runtime.
    const onConnected = mock(() => {});
    const onError = mock(() => {});
    await startClient({
      onConnected,
      onError,
      supportsPairedListenerGenerations: true,
    });
    await waitFor(
      () => countConnectionsForChannel("control") === 1,
      "paired control socket did not open",
    );
    const controlIndex = lastConnectionIndexForChannel("control");
    const firstGeneration = connectionUrls[controlIndex]?.searchParams.get(
      "connectionGeneration",
    );
    acceptConnection(controlIndex, { incarnation: "control-incarnation-1" });
    await waitFor(
      () => countConnectionsForChannel("stream") === 1,
      "paired stream socket did not open",
    );
    const streamIndex = lastConnectionIndexForChannel("stream");
    expect(
      connectionUrls[streamIndex]?.searchParams.get("connectionIncarnation"),
    ).toBe("control-incarnation-1");

    const originalNow = Date.now;
    try {
      const afterStartupBudget = originalNow() + 5 * 60 * 1000 + 1;
      Date.now = () => afterStartupBudget;
      acceptConnection(streamIndex);
      await waitFor(
        () => countConnectionsForChannel("control") === 2,
        "listener did not reconnect after rollout skew exhausted startup budget",
      );
    } finally {
      Date.now = originalNow;
    }
    expect(onConnected).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(
      connectionUrls[
        lastConnectionIndexForChannel("control")
      ]?.searchParams.get("connectionGeneration"),
    ).not.toBe(firstGeneration);
    acceptConnection(lastConnectionIndexForChannel("control"));
    await waitFor(
      () => countConnectionsForChannel("stream") === 2,
      "replacement legacy stream did not open",
    );
    acceptConnection(lastConnectionIndexForChannel("stream"));
    await waitFor(
      () => onConnected.mock.calls.length === 1,
      "replacement pair did not become active",
    );
  });

  test("an old control ack with a new stream ack rejects the pair and reconnects", async () => {
    // Inverse mixed case: an incarnation the control session never issued
    // cannot be adopted from the stream side.
    const onConnected = mock(() => {});
    await startClient({
      onConnected,
      supportsPairedListenerGenerations: true,
    });
    await waitFor(
      () => countConnectionsForChannel("control") === 1,
      "paired control socket did not open",
    );
    acceptConnection(lastConnectionIndexForChannel("control"));
    await waitFor(
      () => countConnectionsForChannel("stream") === 1,
      "paired stream socket did not open",
    );
    const streamIndex = lastConnectionIndexForChannel("stream");
    expect(
      connectionUrls[streamIndex]?.searchParams.has("connectionIncarnation"),
    ).toBe(false);

    acceptConnection(streamIndex, { incarnation: "stream-only-incarnation" });

    await waitFor(
      () => countConnectionsForChannel("control") === 2,
      "listener did not reconnect after an unissued stream incarnation",
    );
    expect(onConnected).not.toHaveBeenCalled();
    acceptConnection(lastConnectionIndexForChannel("control"));
    await waitFor(
      () => countConnectionsForChannel("stream") === 2,
      "replacement legacy stream did not open",
    );
    acceptConnection(lastConnectionIndexForChannel("stream"));
    await waitFor(
      () => onConnected.mock.calls.length === 1,
      "replacement pair did not become active",
    );
  });

  test("version-skewed pairs past the connect budget never end the listener", async () => {
    // Mixed Cloud pods have no affinity guarantee, so skewed pairs can repeat
    // for as long as the rollout takes. Shrink the ordinary connect budget,
    // skew every pair well past it, then let both sides match.
    process.env.LETTA_LISTENER_RETRY_DURATION_MS = "150";
    process.env.LETTA_LISTENER_INITIAL_RETRY_DELAY_MS = "10";
    const onConnected = mock(() => {});
    const onError = mock((_error: Error) => {});
    await startClient({
      onConnected,
      onError,
      supportsPairedListenerGenerations: true,
    });

    // A rejected stream can still emit a late ErrorEvent while it terminates.
    // Inject one on every stream the listener abandons; with no error listener
    // armed it surfaces as an uncaught exception that would kill the CLI.
    const uncaught: unknown[] = [];
    const recordUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", recordUncaught);
    const instrumented = new WeakSet<WebSocket>();
    const instrumentStream = () => {
      const stream = getActiveRuntime()?.streamSocket;
      if (!stream || instrumented.has(stream)) return;
      instrumented.add(stream);
      const terminate = stream.terminate.bind(stream);
      stream.terminate = () => {
        terminate();
        queueMicrotask(() =>
          stream.emit("error", new Error("late terminate error")),
        );
      };
    };

    const startedAt = Date.now();
    let skewedPairs = 0;
    while (Date.now() - startedAt < 600 || skewedPairs < 4) {
      await waitFor(
        () => countConnectionsForChannel("control") > skewedPairs,
        `control socket ${skewedPairs + 1} did not open`,
      );
      const controlIndex = lastConnectionIndexForChannel("control");
      const streams = countConnectionsForChannel("stream");
      // Alternate which side came from the new pod.
      const newControl = skewedPairs % 2 === 0;
      acceptConnection(
        controlIndex,
        newControl ? { incarnation: `control-${skewedPairs}` } : undefined,
      );
      await waitFor(
        () => countConnectionsForChannel("stream") === streams + 1,
        `stream socket ${skewedPairs + 1} did not open`,
      );
      instrumentStream();
      acceptConnection(
        lastConnectionIndexForChannel("stream"),
        newControl ? undefined : { incarnation: `stream-${skewedPairs}` },
      );
      skewedPairs += 1;
      await waitFor(
        () => countConnectionsForChannel("control") > skewedPairs,
        `listener stopped reconnecting after skewed pair ${skewedPairs}`,
      );
      expect(onError).not.toHaveBeenCalled();
      expect(onConnected).not.toHaveBeenCalled();
    }
    expect(Date.now() - startedAt).toBeGreaterThan(150 * 3);

    // The rollout drains: both acknowledgements now come from new pods.
    const controlIndex = lastConnectionIndexForChannel("control");
    const streams = countConnectionsForChannel("stream");
    acceptConnection(controlIndex, { incarnation: "drained" });
    await waitFor(
      () => countConnectionsForChannel("stream") === streams + 1,
      "stream socket did not open after the rollout drained",
    );
    acceptConnection(lastConnectionIndexForChannel("stream"), {
      incarnation: "drained",
    });
    await waitFor(
      () => onConnected.mock.calls.length === 1,
      "listener did not activate once both sides matched",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.off("uncaughtException", recordUncaught);
    expect(uncaught).toEqual([]);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test("ordinary pair failures still exhaust the connect budget", async () => {
    // The skew exemption is narrow: a plain mismatched generation keeps the
    // normal terminal budget.
    process.env.LETTA_LISTENER_RETRY_DURATION_MS = "150";
    process.env.LETTA_LISTENER_INITIAL_RETRY_DELAY_MS = "10";
    const onError = mock((_error: Error) => {});
    await startClient({ onError, supportsPairedListenerGenerations: true });

    let pairs = 0;
    while (onError.mock.calls.length === 0) {
      await waitFor(
        () =>
          onError.mock.calls.length > 0 ||
          countConnectionsForChannel("control") > pairs,
        `control socket ${pairs + 1} did not open`,
      );
      if (onError.mock.calls.length > 0) break;
      // Alternate stale generation and stale attempt.
      acceptConnection(
        lastConnectionIndexForChannel("control"),
        pairs % 2 === 0
          ? { generation: "stale-generation" }
          : { attempt: 999_999 },
      );
      pairs += 1;
      await waitFor(
        () =>
          onError.mock.calls.length > 0 ||
          countConnectionsForChannel("control") > pairs,
        `listener neither retried nor failed after pair ${pairs}`,
      );
    }
    expect(pairs).toBeGreaterThanOrEqual(2);
    expect(onError.mock.calls[0]?.[0].message).toContain("Failed to connect");
  });

  test("mismatched acceptance reconnects with a new generation and attempt", async () => {
    const onConnected = mock(() => {});
    const onError = mock(() => {});
    await startClient({
      onConnected,
      onError,
      supportsPairedListenerGenerations: true,
    });
    await waitFor(
      () => countConnectionsForChannel("control") === 1,
      "first paired control socket did not open",
    );
    const firstControlIndex = lastConnectionIndexForChannel("control");
    const firstUrl = connectionUrls[firstControlIndex];
    acceptConnection(firstControlIndex, { generation: "wrong-generation" });

    await waitFor(
      () => countConnectionsForChannel("control") === 2,
      "listener did not reconnect after mismatched acceptance",
    );
    expect(countConnectionsForChannel("stream")).toBe(0);
    const secondControlIndex = lastConnectionIndexForChannel("control");
    const secondUrl = connectionUrls[secondControlIndex];
    expect(secondUrl?.searchParams.get("connectionAttempt")).toBe("2");
    expect(secondUrl?.searchParams.get("connectionGeneration")).not.toBe(
      firstUrl?.searchParams.get("connectionGeneration"),
    );

    acceptConnection(secondControlIndex);
    await waitFor(
      () => countConnectionsForChannel("stream") === 1,
      "replacement paired stream did not open",
    );
    acceptConnection(lastConnectionIndexForChannel("stream"));
    await waitFor(
      () => onConnected.mock.calls.length === 1,
      "replacement pair did not become active",
    );
    expect(onError).not.toHaveBeenCalled();
  });

  test("a delayed old stream cannot become active after reconnect starts", async () => {
    const onConnected = mock(() => {});
    await startClient({
      onConnected,
      supportsPairedListenerGenerations: true,
    });
    await waitFor(
      () => countConnectionsForChannel("control") === 1,
      "first paired control socket did not open",
    );
    const firstControlIndex = lastConnectionIndexForChannel("control");
    acceptConnection(firstControlIndex);
    await waitFor(
      () => countConnectionsForChannel("stream") === 1,
      "first paired stream socket did not open",
    );
    const firstStreamIndex = lastConnectionIndexForChannel("stream");
    const staleClientStream = getActiveRuntime()?.streamSocket;
    expect(staleClientStream).not.toBeNull();
    expect(onConnected).not.toHaveBeenCalled();

    connections[firstControlIndex]?.terminate();
    await waitFor(
      () => countConnectionsForChannel("control") === 2,
      "replacement control socket did not open",
    );
    if (connections[firstStreamIndex]?.readyState === WebSocket.OPEN) {
      acceptConnection(firstStreamIndex);
    }
    expect(onConnected).not.toHaveBeenCalled();

    const secondControlIndex = lastConnectionIndexForChannel("control");
    expect(
      connectionUrls[secondControlIndex]?.searchParams.get("connectionAttempt"),
    ).toBe("2");
    acceptConnection(secondControlIndex);
    await waitFor(
      () => countConnectionsForChannel("stream") === 2,
      "replacement stream socket did not open",
    );
    const secondStreamIndex = lastConnectionIndexForChannel("stream");
    acceptConnection(secondStreamIndex);
    await waitFor(
      () => onConnected.mock.calls.length === 1,
      "replacement pair did not become active",
    );
    expect(getActiveRuntime()?.streamSocket).not.toBe(staleClientStream);
  });

  test("split stream upgrade rejection retries the paired listener sockets", async () => {
    process.env.LETTA_LISTENER_STREAM_OPEN_TIMEOUT_MS = "1000";
    const onConnected = mock(() => {});
    const onDisconnected = mock(() => {});
    const onNeedsReregister = mock(() => {});
    const onError = mock(() => {});
    await startClient({
      onConnected,
      onDisconnected,
      onNeedsReregister,
      onError,
    });
    await waitFor(
      () =>
        countConnectionsForChannel("control") === 1 &&
        countConnectionsForChannel("stream") === 1,
      "initial split sockets did not open",
    );
    expect(
      connectionUrls.every(
        (url) => !url.searchParams.has("connectionGeneration"),
      ),
    ).toBe(true);
    expect(
      connectionUrls.every((url) => !url.searchParams.has("connectionAttempt")),
    ).toBe(true);
    const listener = getActiveRuntime();
    expect(listener).not.toBeNull();

    rejectNextStreamUpgrade = true;
    const initialControlIndex = lastConnectionIndexForChannel("control");
    connections[initialControlIndex]?.terminate();
    await waitFor(
      () =>
        countConnectionsForChannel("control") === 3 &&
        countConnectionsForChannel("stream") === 2 &&
        streamUpgradeAttempts === 3 &&
        onConnected.mock.calls.length === 2,
      "listener did not retry after the split stream upgrade was rejected",
    );

    expect(getActiveRuntime()).toBe(listener);
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(onNeedsReregister).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test("current split open handler failure reconnects without onError", async () => {
    process.env.LETTA_LISTENER_STREAM_OPEN_TIMEOUT_MS = "1000";
    const onConnected = mock(() => {});
    const onDisconnected = mock(() => {});
    const onNeedsReregister = mock(() => {});
    const onError = mock(() => {});
    await startClient({
      onConnected,
      onDisconnected,
      onNeedsReregister,
      onError,
    });
    await waitFor(
      () =>
        countConnectionsForChannel("control") === 1 &&
        countConnectionsForChannel("stream") === 1 &&
        onConnected.mock.calls.length === 1,
      "initial split sockets did not open",
    );
    const listener = getActiveRuntime();
    const failedControlSocket = listener?.socket;
    const failedStreamSocket = listener?.streamSocket ?? null;
    if (!listener || !failedControlSocket || !failedStreamSocket) {
      throw new Error("initial split socket pair missing");
    }

    const trackOpenFailure = mock(() => {});
    handleListenerSocketOpenFailure({
      runtime: listener,
      controlSocket: failedControlSocket,
      streamSocket: failedStreamSocket,
      error: new Error("split open handler failed"),
      trackListenerError: trackOpenFailure,
    });

    expect(trackOpenFailure).toHaveBeenCalledTimes(1);
    await waitFor(
      () =>
        countConnectionsForChannel("control") === 2 &&
        countConnectionsForChannel("stream") === 2 &&
        onConnected.mock.calls.length === 2,
      "listener did not reconnect after split open handler failure",
    );

    expect(getActiveRuntime()).toBe(listener);
    expect(listener.socket).not.toBe(failedControlSocket);
    expect(listener.streamSocket).not.toBe(failedStreamSocket);
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(onNeedsReregister).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test("split stream handshake stall retries without clearing runtime turn state", async () => {
    // Keep the synthetic stall short without racing healthy socket setup on a
    // loaded Windows runner.
    process.env.LETTA_LISTENER_STREAM_OPEN_TIMEOUT_MS = "500";
    const onConnected = mock(() => {});
    const onDisconnected = mock(() => {});
    const onNeedsReregister = mock(() => {});
    const onError = mock(() => {});
    await startClient({
      onConnected,
      onDisconnected,
      onNeedsReregister,
      onError,
    });
    await waitFor(
      () =>
        countConnectionsForChannel("control") === 1 &&
        countConnectionsForChannel("stream") === 1,
      "initial split sockets did not open",
    );
    expect(onConnected).toHaveBeenCalledTimes(1);

    const listener = getActiveRuntime();
    expect(listener).not.toBeNull();
    if (!listener?.transport) {
      throw new Error("listener transport missing after connect");
    }
    const capturedTransport = listener.transport;
    const conversationRuntime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-1",
    );
    const turnLease = conversationRuntime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
      initialStatus: "EXECUTING_CLIENT_SIDE_TOOL",
      executingToolCallIds: ["call-1"],
    });
    conversationRuntime.turnLifecycle.setRunId(turnLease, "run-1");
    conversationRuntime.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "queued during stalled stream reconnect",
      agentId: "agent-1",
      conversationId: "conv-1",
    } as Parameters<typeof conversationRuntime.queueRuntime.enqueue>[0]);
    const pendingApproval = requestApprovalOverWS(
      conversationRuntime,
      capturedTransport,
      turnLease,
      "perm-stream-stall",
      makeControlRequest("perm-stream-stall"),
    );
    const approvalResult = pendingApproval.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    await waitFor(
      () => conversationRuntime.pendingApprovalResolvers.size === 1,
      "approval resolver was not registered",
    );

    hangNextStreamUpgrade = true;
    const staleControlSocket = listener.socket;
    const staleStreamSocket = listener.streamSocket ?? null;
    if (!staleControlSocket || !staleStreamSocket) {
      throw new Error("initial split socket pair missing");
    }
    const initialControlIndex = lastConnectionIndexForChannel("control");
    connections[initialControlIndex]?.terminate();
    await waitFor(
      () =>
        countConnectionsForChannel("control") === 2 &&
        streamUpgradeAttempts === 2,
      "replacement control did not open with stalled stream handshake",
    );
    expect(onConnected).toHaveBeenCalledTimes(1);

    await waitFor(
      () =>
        countConnectionsForChannel("control") === 3 &&
        countConnectionsForChannel("stream") === 2 &&
        streamUpgradeAttempts === 3 &&
        stalledUpgradeSockets.size === 0 &&
        onConnected.mock.calls.length === 2,
      "listener did not retry after stalled split stream handshake",
    );

    expect(getActiveRuntime()).toBe(listener);
    expect(conversationRuntime.turnLifecycle.kind).toBe("active");
    expect(conversationRuntime.loopStatus).toBe("WAITING_ON_APPROVAL");
    expect(conversationRuntime.queueRuntime.length).toBe(1);
    expect(conversationRuntime.pendingApprovalResolvers.size).toBe(1);
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(onNeedsReregister).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    const recoveredControlSocket = listener.socket;
    const recoveredStreamSocket = listener.streamSocket;
    const trackStaleFailure = mock(() => {});
    handleListenerSocketOpenFailure({
      runtime: listener,
      controlSocket: staleControlSocket,
      streamSocket: staleStreamSocket,
      error: new Error("late failure from stale open handler"),
      trackListenerError: trackStaleFailure,
    });
    expect(trackStaleFailure).not.toHaveBeenCalled();
    expect(listener.socket).toBe(recoveredControlSocket);
    expect(listener.streamSocket).toBe(recoveredStreamSocket);
    expect(onError).not.toHaveBeenCalled();

    const controlCountAfterRecovery = countConnectionsForChannel("control");
    const streamCountAfterRecovery = countConnectionsForChannel("stream");
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(countConnectionsForChannel("control")).toBe(
      controlCountAfterRecovery,
    );
    expect(countConnectionsForChannel("stream")).toBe(streamCountAfterRecovery);

    expect(
      resolvePendingApprovalResolver(conversationRuntime, {
        request_id: "perm-stream-stall",
        decision: { behavior: "allow" },
      }),
    ).toBe(true);
    expect(await approvalResult).toMatchObject({
      ok: true,
      value: {
        request_id: "perm-stream-stall",
        decision: { behavior: "allow" },
      },
    });
    expect(conversationRuntime.pendingApprovalResolvers.size).toBe(0);

    conversationRuntime.turnLifecycle.finish(turnLease, "end_turn");
  });
});
