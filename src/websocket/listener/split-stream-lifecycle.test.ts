import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
import { requestApprovalOverWS } from "@/websocket/listener/approval";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import { handleListenerSocketOpenFailure } from "@/websocket/listener/split-stream-lifecycle";

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
  let connectionGenerations: Array<string | null>;
  let streamFrames: unknown[];
  let delayNextControlUpgradeMs: number;
  let readyGenerationForNextControl: string | null;
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
    connectionGenerations = [];
    streamFrames = [];
    delayNextControlUpgradeMs = 0;
    readyGenerationForNextControl = null;
    hangNextStreamUpgrade = false;
    rejectNextStreamUpgrade = false;
    streamUpgradeAttempts = 0;
    stalledUpgradeSockets = new Set();
    server = new WebSocketServer({ noServer: true });
    httpServer = createServer();
    httpServer.on("upgrade", (request, socket, head) => {
      const requestUrl = new URL(request.url ?? "/", "ws://127.0.0.1");
      const channel = requestUrl.searchParams.get("channel");
      const completeUpgrade = () => {
        server.handleUpgrade(request, socket, head, (upgradedSocket) => {
          server.emit("connection", upgradedSocket, request);
        });
      };
      if (channel === "control" && delayNextControlUpgradeMs > 0) {
        const delayMs = delayNextControlUpgradeMs;
        delayNextControlUpgradeMs = 0;
        setTimeout(completeUpgrade, delayMs);
        return;
      }
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
      completeUpgrade();
    });
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", resolve),
    );
    const address = httpServer.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${address.port}`;
    server.on("connection", (socket, request) => {
      connections.push(socket);
      const requestUrl = new URL(request.url ?? "/", "ws://127.0.0.1");
      connectionChannels.push(requestUrl.searchParams.get("channel"));
      connectionGenerations.push(
        requestUrl.searchParams.get("connectionGeneration"),
      );
      if (
        requestUrl.searchParams.get("channel") === "control" &&
        readyGenerationForNextControl
      ) {
        const generation = readyGenerationForNextControl;
        readyGenerationForNextControl = null;
        socket.send(
          JSON.stringify({
            type: "listener_ready",
            connection_generation: generation,
          }),
        );
      }
      if (requestUrl.searchParams.get("channel") === "stream") {
        socket.on("message", (data) => {
          streamFrames.push(JSON.parse(data.toString()));
        });
      }
    });
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
    if (originalStreamOpenTimeout === undefined) {
      delete process.env.LETTA_LISTENER_STREAM_OPEN_TIMEOUT_MS;
    } else {
      process.env.LETTA_LISTENER_STREAM_OPEN_TIMEOUT_MS =
        originalStreamOpenTimeout;
    }
  });

  function startClient(overrides: {
    supportsPairedListenerGenerations?: boolean;
    onConnected?: (connectionId?: string) => void;
    onDisconnected?: () => void;
    onNeedsReregister?: () => void;
    onError?: (error: Error) => void;
    onStatusChange?: (status: "idle" | "receiving" | "processing") => void;
    onWsEvent?: (
      direction: "send" | "recv",
      label: "client" | "protocol" | "control" | "lifecycle",
      event: unknown,
    ) => void;
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
      onStatusChange: overrides.onStatusChange,
      onWsEvent: overrides.onWsEvent,
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

  function sendListenerReady(generation: string): void {
    const index = lastConnectionIndexForChannel("control");
    const controlSocket = connections[index];
    if (!controlSocket) throw new Error("control socket is not connected");
    controlSocket.send(
      JSON.stringify({
        type: "listener_ready",
        connection_generation: generation,
      }),
    );
  }

  function streamGenerations(): Array<string | null> {
    return connectionGenerations.filter(
      (_, index) => connectionChannels[index] === "stream",
    );
  }

  test("paired generations open control first and delay status until stream opens", async () => {
    const onConnected = mock(() => {});
    const onWsEvent = mock(
      (
        _direction: "send" | "recv",
        _label: "client" | "protocol" | "control" | "lifecycle",
        _event: unknown,
      ) => {},
    );
    await startClient({
      supportsPairedListenerGenerations: true,
      onConnected,
      onWsEvent,
    });

    await waitFor(
      () => countConnectionsForChannel("control") === 1,
      "paired control socket did not open",
    );
    const runtime = getActiveRuntime();
    if (!runtime) throw new Error("listener runtime was not created");
    getOrCreateScopedRuntime(runtime, "agent-1", "conv-1");
    expect(countConnectionsForChannel("stream")).toBe(0);
    expect(streamUpgradeAttempts).toBe(0);
    expect(onConnected).not.toHaveBeenCalled();
    expect(streamFrames).toEqual([]);

    sendListenerReady("generation-1");
    await waitFor(
      () =>
        countConnectionsForChannel("stream") === 1 &&
        onConnected.mock.calls.length === 1 &&
        streamFrames.length > 0,
      "paired stream socket did not open and emit status after listener_ready",
    );
    expect(streamGenerations()).toEqual(["generation-1"]);
    expect(onWsEvent.mock.calls).toContainEqual([
      "recv",
      "lifecycle",
      {
        type: "listener_ready",
        connection_generation: "generation-1",
      },
    ]);
    expect(
      onWsEvent.mock.calls.some(
        ([direction, label, event]) =>
          direction === "recv" &&
          label === "client" &&
          (event as { type?: string }).type === "listener_ready",
      ),
    ).toBe(false);
  });

  test("listener_ready timeout starts after the control socket opens", async () => {
    process.env.LETTA_LISTENER_STREAM_OPEN_TIMEOUT_MS = "25";
    delayNextControlUpgradeMs = 75;
    readyGenerationForNextControl = "generation-after-delayed-upgrade";
    const onConnected = mock(() => {});

    await startClient({
      supportsPairedListenerGenerations: true,
      onConnected,
    });
    await waitFor(
      () => onConnected.mock.calls.length === 1,
      "listener rejected listener_ready after a delayed control upgrade",
    );

    expect(countConnectionsForChannel("control")).toBe(1);
    expect(streamGenerations()).toEqual(["generation-after-delayed-upgrade"]);
  });

  test("paired reconnect waits for a fresh listener generation", async () => {
    const onConnected = mock(() => {});
    await startClient({
      supportsPairedListenerGenerations: true,
      onConnected,
    });
    await waitFor(
      () => countConnectionsForChannel("control") === 1,
      "initial control socket did not open",
    );
    sendListenerReady("generation-1");
    await waitFor(
      () => onConnected.mock.calls.length === 1,
      "initial paired listener did not connect",
    );

    connections[lastConnectionIndexForChannel("control")]?.terminate();
    await waitFor(
      () => countConnectionsForChannel("control") === 2,
      "replacement control socket did not open",
    );
    expect(countConnectionsForChannel("stream")).toBe(1);
    expect(onConnected).toHaveBeenCalledTimes(1);

    sendListenerReady("generation-2");
    await waitFor(
      () => onConnected.mock.calls.length === 2,
      "replacement paired listener did not connect",
    );
    expect(streamGenerations()).toEqual(["generation-1", "generation-2"]);
  });

  test("listener_ready timeout reconnects without opening a stream", async () => {
    process.env.LETTA_LISTENER_STREAM_OPEN_TIMEOUT_MS = "25";
    const onConnected = mock(() => {});
    const onDisconnected = mock(() => {});
    const onError = mock(() => {});
    await startClient({
      supportsPairedListenerGenerations: true,
      onConnected,
      onDisconnected,
      onError,
    });

    await waitFor(
      () => countConnectionsForChannel("control") === 2,
      "listener did not reconnect after listener_ready timeout",
    );
    expect(countConnectionsForChannel("stream")).toBe(0);
    expect(onConnected).not.toHaveBeenCalled();
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test("control close before listener_ready reconnects the pair", async () => {
    const onConnected = mock(() => {});
    await startClient({
      supportsPairedListenerGenerations: true,
      onConnected,
    });
    await waitFor(
      () => countConnectionsForChannel("control") === 1,
      "initial control socket did not open",
    );
    connections[lastConnectionIndexForChannel("control")]?.terminate();
    await waitFor(
      () => countConnectionsForChannel("control") === 2,
      "control socket did not reconnect before listener_ready",
    );
    expect(countConnectionsForChannel("stream")).toBe(0);

    sendListenerReady("generation-after-close");
    await waitFor(
      () => onConnected.mock.calls.length === 1,
      "replacement pair did not connect",
    );
    expect(streamGenerations()).toEqual(["generation-after-close"]);
  });

  test("legacy split capability still opens both sockets without listener_ready", async () => {
    const onConnected = mock(() => {});
    await startClient({ onConnected });
    await waitFor(
      () =>
        countConnectionsForChannel("control") === 1 &&
        countConnectionsForChannel("stream") === 1 &&
        onConnected.mock.calls.length === 1,
      "legacy split sockets did not open in parallel",
    );
    expect(streamGenerations()).toEqual([null]);
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
    process.env.LETTA_LISTENER_STREAM_OPEN_TIMEOUT_MS = "25";
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

    const finalControlIndex = lastConnectionIndexForChannel("control");
    connections[finalControlIndex]?.send(
      JSON.stringify({
        type: "input",
        runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
        payload: {
          kind: "approval_response",
          request_id: "perm-stream-stall",
          decision: { behavior: "allow" },
        },
      }),
    );
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
