import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { settingsManager } from "@/settings-manager";
import {
  startListenerClient,
  stopListenerClient,
} from "@/websocket/listen-client";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import {
  MAX_CONSECUTIVE_LISTENER_STARTUP_TIMEOUTS,
  resetListenerStartupTimeoutsForTests,
} from "@/websocket/listener/startup-deadline";

type ListenerSettings = Awaited<
  ReturnType<typeof settingsManager.getSettingsWithSecureTokens>
>;

const ENV_KEYS = [
  "HOME",
  "LETTA_DISABLE_CRON_SCHEDULER",
  "LETTA_DISABLE_MODS",
  "LETTA_API_KEY",
  "LETTA_BASE_URL",
  "LETTA_LISTENER_STARTUP_DEADLINE_MS",
] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);
const originalGetSettingsWithSecureTokens =
  settingsManager.getSettingsWithSecureTokens;
const originalUpdateSettings = settingsManager.updateSettings;
const originalFlush = settingsManager.flush;

let testHome: string;
let server: WebSocketServer;
let wsUrl: string;
let serverSockets: WebSocket[];

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

beforeEach(async () => {
  stopListenerClient();
  resetListenerStartupTimeoutsForTests();
  await settingsManager.reset();
  testHome = await mkdtemp(join(tmpdir(), "letta-startup-deadline-"));
  process.env.HOME = testHome;
  process.env.LETTA_DISABLE_CRON_SCHEDULER = "1";
  process.env.LETTA_DISABLE_MODS = "1";
  process.env.LETTA_LISTENER_STARTUP_DEADLINE_MS = "100";
  delete process.env.LETTA_API_KEY;
  delete process.env.LETTA_BASE_URL;
  await settingsManager.initialize();

  const settings: ListenerSettings = {
    ...settingsManager.getSettings(),
    env: { LETTA_API_KEY: "access-token" },
    refreshToken: "refresh-token",
    tokenExpiresAt: Date.now() + 60 * 60 * 1000,
  };
  settingsManager.getSettingsWithSecureTokens = mock(
    async () => settings,
  ) as typeof settingsManager.getSettingsWithSecureTokens;
  settingsManager.updateSettings = mock(
    () => {},
  ) as typeof settingsManager.updateSettings;
  settingsManager.flush = mock(async () => {}) as typeof settingsManager.flush;

  serverSockets = [];
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on("connection", (socket) => {
    serverSockets.push(socket);
  });
});

afterEach(async () => {
  stopListenerClient();
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 100);
    server.close(() => {
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
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test(
  "a startup step that never resolves trips the deadline, recycles the socket, and exits after repeated stalls",
  async () => {
    const logs: string[] = [];
    const onError = mock((_error: Error) => {});
    const onConnectionReady = mock(() => new Promise<void>(() => {}));

    await startListenerClient({
      connectionId: "connection-id",
      wsUrl,
      deviceId: "device-id",
      connectionName: "listener-name",
      onConnected: () => {},
      onConnectionReady,
      onDisconnected: mock(() => {}),
      onNeedsReregister: mock(() => {}),
      onError,
      onLog: (message) => logs.push(message),
    });

    await waitFor(
      () => onError.mock.calls.length === 1,
      "listener never gave up on a stalled startup",
    );

    expect(serverSockets).toHaveLength(
      MAX_CONSECUTIVE_LISTENER_STARTUP_TIMEOUTS,
    );
    await waitFor(
      () =>
        serverSockets.every((socket) => socket.readyState === WebSocket.CLOSED),
      "stalled sockets were not terminated",
    );
    expect(onConnectionReady).toHaveBeenCalledTimes(
      MAX_CONSECUTIVE_LISTENER_STARTUP_TIMEOUTS,
    );
    expect(onError.mock.calls[0]?.[0].message).toContain(
      "last step: ingress drained",
    );
    expect(getActiveRuntime()).toBeNull();

    const stepLines = logs.filter((line) => line.includes("startup: "));
    expect(stepLines.slice(0, 3)).toEqual([
      "[Listen] startup: initial state sent",
      "[Listen] startup: recovery done",
      "[Listen] startup: ingress drained",
    ]);
    expect(logs.some((line) => line.includes("heartbeat started"))).toBe(false);
    expect(
      logs.filter((line) => line.includes("startup did not finish")),
    ).toHaveLength(MAX_CONSECUTIVE_LISTENER_STARTUP_TIMEOUTS);
    expect(
      logs.filter((line) => line.startsWith("[Listen] control socket closed")),
    ).toHaveLength(MAX_CONSECUTIVE_LISTENER_STARTUP_TIMEOUTS - 1);

    // No reconnect after giving up.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(serverSockets).toHaveLength(
      MAX_CONSECUTIVE_LISTENER_STARTUP_TIMEOUTS,
    );
  },
  { timeout: 20_000 },
);

test("a started heartbeat clears the deadline", async () => {
  const logs: string[] = [];
  const onError = mock((_error: Error) => {});

  await startListenerClient({
    connectionId: "connection-id",
    wsUrl,
    deviceId: "device-id",
    connectionName: "listener-name",
    onConnected: () => {},
    onDisconnected: mock(() => {}),
    onNeedsReregister: mock(() => {}),
    onError,
    onLog: (message) => logs.push(message),
  });

  await waitFor(
    () => logs.includes("[Listen] startup: heartbeat started"),
    "heartbeat never started",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(onError).not.toHaveBeenCalled();
  expect(serverSockets).toHaveLength(1);
  expect(serverSockets[0]?.readyState).toBe(WebSocket.OPEN);
});
