import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { attachListenerConnection } from "@/websocket/listener/connection";
import { createRuntime } from "@/websocket/listener/lifecycle";
import type { StartListenerOptions } from "@/websocket/listener/types";

class MockSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;

  send(_payload: string): void {}
}

describe("listener connection attachment", () => {
  test("disconnect cleanup runs exactly once without stopping the process runtime", () => {
    const runtime = createRuntime();
    const socket = new MockSocket();
    const onDisconnected = mock(() => {});
    const onClosed = mock(() => {});
    const options: StartListenerOptions = {
      connectionId: "connection-1",
      wsUrl: "ws://127.0.0.1/ws",
      deviceId: "device-1",
      connectionName: "test-client",
      onConnected: () => {},
      onDisconnected,
      onError: () => {},
    };

    attachListenerConnection(runtime, socket as unknown as WebSocket, options, {
      scopeHooks: {
        claim: () => "claimed",
        release: () => {},
        owns: () => true,
      },
      onClosed,
    });

    socket.emit("close");
    socket.emit("close");

    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(runtime.intentionallyClosed).toBe(false);
  });
});
