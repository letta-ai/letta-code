import { afterEach, expect, test } from "bun:test";
import WebSocket from "ws";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";

const TEST_TIMEOUT_MS = 5000;
let handle: AppServerHandle | null = null;
let client: WebSocket | null = null;

function waitForEvent(
  socket: WebSocket,
  event: "open" | "ping",
): Promise<void> {
  if (event === "open" && socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for websocket ${event}`));
    }, TEST_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off(event, handleEvent);
      socket.off("error", handleError);
    };
    const handleEvent = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once(event, handleEvent);
    socket.once("error", handleError);
  });
}

afterEach(async () => {
  if (
    client?.readyState === WebSocket.OPEN ||
    client?.readyState === WebSocket.CONNECTING
  ) {
    client.close();
  }
  client = null;
  await handle?.close();
  handle = null;
});

test("app-server heartbeat probes after a local event-loop stall", async () => {
  handle = await startAppServer({
    listen: "ws://127.0.0.1:0",
    heartbeatIntervalMs: 20,
    pongTimeoutMs: 60,
  });
  client = new WebSocket(handle.controlUrl);
  await waitForEvent(client, "open");
  await waitForEvent(client, "ping");

  // Simulate CPU starvation or sleep/wake delaying the watchdog callback beyond
  // its wall-clock timeout. The next callback must send a fresh probe instead
  // of immediately killing a client that can still pong.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  await waitForEvent(client, "ping");
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(client.readyState).toBe(WebSocket.OPEN);
});
