import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { settingsManager } from "@/settings-manager";
import {
  startListenerClient,
  stopListenerClient,
} from "@/websocket/listen-client";
import { createInterruptedTurnStore } from "@/websocket/listener/interrupted-turn-record";

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
    // Keep transport liveness healthy even while startup is blocked.
    const pongs = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"pong"}');
    }, 10);
    socket.once("close", () => clearInterval(pongs));
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
  "a recovery fetch hung after reconnect closes the socket and retries",
  async () => {
    const logs: string[] = [];
    const requests: string[] = [];
    let readyCount = 0;
    const backend = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      const url = request.url ?? "";
      if (url.startsWith("/v1/agents/agent-1/runtime-status")) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            statuses: [{ conversation_id: "conv-1", state: "IDLE" }],
          }),
        );
        return;
      }
      if (url.startsWith("/v1/agents/agent-1") && !url.includes("/messages")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: "agent-1", name: "agent" }));
        return;
      }
      // Anything else (the resume fetch) never answers.
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    process.env.LETTA_BASE_URL = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    const onError = mock((_error: Error) => {});
    try {
      await startListenerClient({
        connectionId: "conn-recovery",
        wsUrl,
        deviceId: "device-id",
        connectionName: "listener-name",
        onConnected: () => {},
        onConnectionReady: async () => {
          readyCount += 1;
        },
        onDisconnected: mock(() => {}),
        onNeedsReregister: mock(() => {}),
        onError,
        onLog: (message) => logs.push(message),
      });
      await waitFor(
        () => readyCount === 1,
        "initial connection never became ready",
      );
      createInterruptedTurnStore().write({
        agentId: "agent-1",
        conversationId: "conv-1",
        runId: "run-1",
        toolCallIds: ["call-1"],
        results: [],
        requestOtid: "request-1",
        workingDirectory: testHome,
      });
      serverSockets[0]?.terminate();
      await waitFor(
        () => readyCount === 2,
        "listener never became ready after a stalled reconnect",
      );
      expect(requests).toContain("GET /v1/conversations/conv-1");
      expect(logs).toContain(
        "Listener startup did not finish within 100ms; reconnecting",
      );
      expect(serverSockets).toHaveLength(3);
      expect(serverSockets[1]?.readyState).toBe(WebSocket.CLOSED);
      expect(serverSockets[2]?.readyState).toBe(WebSocket.OPEN);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      stopListenerClient();
      backend.closeAllConnections();
      backend.close();
    }
  },
  { timeout: 20_000 },
);

test("a completed startup clears the deadline", async () => {
  let ready = false;
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
    onConnectionReady: async () => {
      ready = true;
    },
  });

  await waitFor(() => ready, "startup never completed");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(onError).not.toHaveBeenCalled();
  expect(serverSockets).toHaveLength(1);
  expect(serverSockets[0]?.readyState).toBe(WebSocket.OPEN);
});
