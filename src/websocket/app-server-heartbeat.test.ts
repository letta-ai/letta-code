import { expect, test } from "bun:test";
import WebSocket from "ws";
import { type AppServerHandle, startAppServer } from "./app-server";

async function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function blockEventLoop(durationMs: number): void {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    // Reproduce a delayed heartbeat callback without yielding to socket I/O.
  }
}

test("a delayed first heartbeat probes the client before terminating it", async () => {
  let handle: AppServerHandle | null = null;
  let socket: WebSocket | null = null;
  try {
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      heartbeatIntervalMs: 20,
      pongTimeoutMs: 60,
    });
    socket = new WebSocket(handle.controlUrl);
    await waitForOpen(socket);

    blockEventLoop(100);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    socket?.close();
    await handle?.close();
  }
});
