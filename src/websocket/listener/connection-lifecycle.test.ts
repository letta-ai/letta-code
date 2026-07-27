import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import {
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import {
  cleanupListenerConnection,
  closeListenerRuntimeConnections,
} from "./connection-lifecycle";
import { createRuntime } from "./lifecycle";
import type { StartListenerOptions } from "./types";

class MockSocket {
  readonly bufferedAmount = 0;
  readyState = WebSocket.OPEN;
  closeCalls = 0;
  removeAllListenersCalls = 0;

  isOpen(): boolean {
    return this.readyState === WebSocket.OPEN;
  }

  send(_data: string): void {}

  close(): void {
    this.closeCalls += 1;
  }

  removeAllListeners(): this {
    this.removeAllListenersCalls += 1;
    return this;
  }
}

function makeOptions(connectionId: string): StartListenerOptions {
  return {
    connectionId,
    wsUrl: "ws://listener.test",
    deviceId: connectionId,
    connectionName: connectionId,
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

describe("listener connection lifecycle", () => {
  test("connection cleanup preserves other subscribers", () => {
    const runtime = createRuntime();
    const socketA = new MockSocket();
    const socketB = new MockSocket();
    openListenerConnection({
      runtime,
      connectionId: "a",
      writer: socketA as never,
      options: makeOptions("a"),
    });
    openListenerConnection({
      runtime,
      connectionId: "b",
      writer: socketB as never,
      options: makeOptions("b"),
    });
    const scope = { agent_id: "agent-1", conversation_id: "conversation-1" };
    subscribeListenerConnection(runtime, "a", scope);
    subscribeListenerConnection(runtime, "b", scope);

    cleanupListenerConnection(runtime, "b");

    expect(runtime.connections.has("a")).toBe(true);
    expect(runtime.connections.has("b")).toBe(false);
    expect([...runtime.connectionIdsByRuntimeKey.values()][0]).toEqual(
      new Set(["a"]),
    );
  });

  test("global shutdown closes every socket and suppresses callbacks", () => {
    const runtime = createRuntime();
    const socketA = new MockSocket();
    const socketB = new MockSocket();
    openListenerConnection({
      runtime,
      connectionId: "a",
      writer: socketA as never,
      options: makeOptions("a"),
    });
    openListenerConnection({
      runtime,
      connectionId: "b",
      writer: socketB as never,
      options: makeOptions("b"),
    });

    closeListenerRuntimeConnections(runtime, true);

    expect(runtime.connections.size).toBe(0);
    expect(socketA.removeAllListenersCalls).toBe(1);
    expect(socketB.removeAllListenersCalls).toBe(1);
    expect(socketA.closeCalls).toBe(1);
    expect(socketB.closeCalls).toBe(1);
  });
});
