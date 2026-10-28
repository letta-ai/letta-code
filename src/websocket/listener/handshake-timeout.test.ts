import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { settingsManager } from "@/settings-manager";
import {
  startListenerClient,
  stopListenerClient,
} from "@/websocket/listen-client";
import { createListenerSocket } from "@/websocket/listener/handshake-deadline";

type ListenerSettings = Awaited<
  ReturnType<typeof settingsManager.getSettingsWithSecureTokens>
>;

const ENV_KEYS = [
  "HOME",
  "LETTA_DISABLE_CRON_SCHEDULER",
  "LETTA_DISABLE_MODS",
  "LETTA_API_KEY",
  "LETTA_BASE_URL",
  "LETTA_LISTENER_HANDSHAKE_TIMEOUT_MS",
] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);
const originalGetSettingsWithSecureTokens =
  settingsManager.getSettingsWithSecureTokens;
const originalUpdateSettings = settingsManager.updateSettings;
const originalFlush = settingsManager.flush;

let testHome: string;
let server: Server;
let wsUrl: string;
let tcpSockets: Socket[];

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
  testHome = await mkdtemp(join(tmpdir(), "letta-handshake-timeout-"));
  process.env.HOME = testHome;
  process.env.LETTA_DISABLE_CRON_SCHEDULER = "1";
  process.env.LETTA_DISABLE_MODS = "1";
  process.env.LETTA_LISTENER_HANDSHAKE_TIMEOUT_MS = "100";
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

  // Accepts TCP but never answers the HTTP upgrade, like a blackholed NAT path.
  tcpSockets = [];
  server = createServer((socket) => {
    tcpSockets.push(socket);
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  stopListenerClient();
  for (const socket of tcpSockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
  "a hung upgrade handshake times out and schedules a retry",
  async () => {
    const logs: string[] = [];
    const retryAttempts: number[] = [];
    const onError = mock((_error: Error) => {});

    await startListenerClient({
      connectionId: "conn-handshake",
      wsUrl,
      deviceId: "device-id",
      connectionName: "listener-name",
      onConnected: () => {},
      onDisconnected: mock(() => {}),
      onNeedsReregister: mock(() => {}),
      onError,
      onRetrying: (attempt) => {
        retryAttempts.push(attempt);
      },
      onLog: (message) => logs.push(message),
    });

    await waitFor(
      () => retryAttempts.includes(1) && tcpSockets.length >= 2,
      "hung handshake never errored, closed, and retried",
      15_000, // generous vs the 100ms handshake timeout + 1s retry backoff
    );
    expect(
      logs.some((line) => line.includes("control socket error")),
    ).toBeTrue();
    expect(onError).not.toHaveBeenCalled();
  },
  { timeout: 20_000 },
);

test("a listener socket stuck CONNECTING is terminated at the deadline", async () => {
  const socket = createListenerSocket(new URL(wsUrl), "access-token");
  const closed = new Promise<number>((resolve) =>
    socket.once("close", (code: number) => resolve(code)),
  );
  socket.on("error", () => {});
  expect(socket.readyState).toBe(WebSocket.CONNECTING);
  expect(await closed).toBe(1006);
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});
