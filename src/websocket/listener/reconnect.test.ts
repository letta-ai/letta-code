import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import { settingsManager } from "@/settings-manager";
import { startListenerClient, stopListenerClient } from "./lifecycle";
import { __listenerReconnectTestUtils } from "./reconnect";
import { getActiveRuntime } from "./runtime";

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

describe("listener reconnect liveness", () => {
  const originalApiKey = process.env.LETTA_API_KEY;
  const originalDisableCron = process.env.LETTA_DISABLE_CRON_SCHEDULER;
  const originalDisableMods = process.env.LETTA_DISABLE_MODS;
  const originalHome = process.env.HOME;

  let httpServer: Server;
  let wsServer: WebSocketServer;
  let sockets: Socket[];
  let accepted: WebSocket[];
  let controlUpgrades: number;
  let rejectNextControlUpgrade: boolean;
  let rejectControlUpgrades: boolean;
  let wsUrl: string;
  let testHome: string;

  beforeEach(async () => {
    stopListenerClient();
    await settingsManager.reset();
    testHome = await mkdtemp(join(tmpdir(), "letta-reconnect-liveness-"));
    process.env.HOME = testHome;
    process.env.LETTA_API_KEY = "listener-reconnect-test-key";
    process.env.LETTA_DISABLE_CRON_SCHEDULER = "1";
    process.env.LETTA_DISABLE_MODS = "1";
    await settingsManager.initialize();

    sockets = [];
    accepted = [];
    controlUpgrades = 0;
    rejectNextControlUpgrade = false;
    rejectControlUpgrades = false;
    __listenerReconnectTestUtils.reset();
    wsServer = new WebSocketServer({ noServer: true });
    wsServer.on("connection", (socket) => {
      accepted.push(socket);
    });

    httpServer = createServer();
    httpServer.on("connection", (socket) => sockets.push(socket));
    httpServer.on("upgrade", (request, socket, head) => {
      const channel = new URL(
        request.url ?? "/",
        "http://listener.test",
      ).searchParams.get("channel");
      if (channel === "control") {
        controlUpgrades += 1;
        if (rejectControlUpgrades || rejectNextControlUpgrade) {
          rejectNextControlUpgrade = false;
          socket.end(
            "HTTP/1.1 503 Service Unavailable\r\n" +
              "Connection: close\r\n" +
              "Content-Length: 0\r\n\r\n",
          );
          return;
        }
      }
      wsServer.handleUpgrade(request, socket, head, (websocket) => {
        wsServer.emit("connection", websocket, request);
      });
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    stopListenerClient();
    __listenerReconnectTestUtils.reset();
    for (const socket of accepted) socket.terminate();
    for (const socket of sockets) socket.destroy();
    wsServer.close();
    httpServer.closeAllConnections();
    httpServer.close();
    await settingsManager.reset();
    await rm(testHome, { recursive: true, force: true });

    process.env.HOME = originalHome;
    if (originalApiKey === undefined) delete process.env.LETTA_API_KEY;
    else process.env.LETTA_API_KEY = originalApiKey;
    if (originalDisableCron === undefined)
      delete process.env.LETTA_DISABLE_CRON_SCHEDULER;
    else process.env.LETTA_DISABLE_CRON_SCHEDULER = originalDisableCron;
    if (originalDisableMods === undefined)
      delete process.env.LETTA_DISABLE_MODS;
    else process.env.LETTA_DISABLE_MODS = originalDisableMods;
  });

  test("recovers after one reconnect upgrade is rejected", async () => {
    const onConnected = mock(() => {});
    await startListenerClient({
      connectionId: "connection-id",
      wsUrl,
      supportsSplitStatusChannels: true,
      deviceId: "device-id",
      connectionName: "listener-name",
      onConnected,
      onDisconnected: mock(() => {}),
      onNeedsReregister: mock(() => {}),
      onError: mock(() => {}),
    });

    await waitFor(
      () => onConnected.mock.calls.length === 1,
      "initial control and stream sockets did not connect",
    );
    rejectNextControlUpgrade = true;
    accepted[0]?.terminate();

    await waitFor(
      () => controlUpgrades >= 3 && onConnected.mock.calls.length >= 2,
      "listener stalled after the rejected reconnect upgrade",
    );
    expect(controlUpgrades).toBeGreaterThanOrEqual(3);
  });

  test("transfers stalled recovery exclusively to fresh registration", async () => {
    __listenerReconnectTestUtils.setStallTimeoutMs(100);
    const onConnected = mock((_connectionId: string) => {});
    let releaseRegistration: (() => void) | undefined;
    const registrationBarrier = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    const onNeedsReregister = mock(async () => {
      await registrationBarrier;
      rejectControlUpgrades = false;
      await startListenerClient(clientOptions("fresh-connection-id"));
    });
    const clientOptions = (connectionId: string) => ({
      connectionId,
      wsUrl,
      supportsSplitStatusChannels: true,
      deviceId: "device-id",
      connectionName: "listener-name",
      onConnected,
      onDisconnected: mock(() => {}),
      onNeedsReregister,
      onError: mock(() => {}),
    });

    await startListenerClient(clientOptions("stale-connection-id"));

    await waitFor(
      () => onConnected.mock.calls.length === 1,
      "initial control and stream sockets did not connect",
    );
    rejectControlUpgrades = true;
    accepted[0]?.terminate();

    await waitFor(
      () => onNeedsReregister.mock.calls.length === 1,
      "stalled reconnect did not request fresh registration",
      1_000,
    );
    await waitFor(
      () => getActiveRuntime()?.socket === null,
      "stale control and stream sockets were not torn down",
    );
    expect(getActiveRuntime()?.streamSocket).toBeNull();
    expect(getActiveRuntime()?.transport).toBeNull();
    const upgradesAtOwnershipTransfer = controlUpgrades;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(controlUpgrades).toBe(upgradesAtOwnershipTransfer);
    expect(onNeedsReregister).toHaveBeenCalledTimes(1);

    releaseRegistration?.();
    await waitFor(
      () => onConnected.mock.calls.length === 2,
      "fresh control and stream sockets did not replace the stalled runtime",
    );
    expect(onConnected).toHaveBeenCalledTimes(2);
    expect(onConnected.mock.calls[1]?.[0]).toBe("fresh-connection-id");
  });
});
