import { describe, expect, test } from "bun:test";
import {
  closeListenerConnection,
  createConnectionRequestKey,
  getOrCreateProcessTransport,
  getSubscribedListenerConnections,
  markListenerConnectionInitialized,
  openListenerConnection,
  selectListenerController,
  subscribeListenerConnection,
} from "./connection";
import { createRuntime } from "./lifecycle";
import type { LocalTransport } from "./transport";
import type { StartListenerOptions } from "./types";

class MockTransport implements LocalTransport {
  readonly kind = "local" as const;
  readonly bufferedAmount = 0;
  readonly sent: string[] = [];
  open = true;

  isOpen(): boolean {
    return this.open;
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

function options(connectionId: string): StartListenerOptions {
  return {
    connectionId,
    wsUrl: "local://test",
    deviceId: "test-device",
    connectionName: connectionId,
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

function addConnection(
  connectionId: string,
  runtime = createRuntime(),
): { runtime: ReturnType<typeof createRuntime>; writer: MockTransport } {
  const writer = new MockTransport();
  openListenerConnection({
    runtime,
    connectionId,
    writer,
    options: options(connectionId),
  });
  markListenerConnectionInitialized(runtime, connectionId);
  return { runtime, writer };
}

describe("listener connection identity", () => {
  test("correlates identical wire request ids by connection", () => {
    expect(createConnectionRequestKey("client-a", "request-1")).not.toBe(
      createConnectionRequestKey("client-b", "request-1"),
    );
  });

  test("tracks multiple subscribers without choosing an owner", () => {
    const { runtime } = addConnection("client-a");
    addConnection("client-b", runtime);
    addConnection("client-c", runtime);
    const scope = { agent_id: "agent-1", conversation_id: "conversation-1" };

    subscribeListenerConnection(runtime, "client-a", scope);
    subscribeListenerConnection(runtime, "client-b", scope);

    expect(
      getSubscribedListenerConnections(runtime, scope).map(
        (connection) => connection.id,
      ),
    ).toEqual(["client-a", "client-b"]);
    expect(runtime.connections.get("client-c")?.subscriptions.size).toBe(0);
  });

  test("selects the origin or oldest subscriber deterministically", () => {
    const { runtime, writer: writerA } = addConnection("client-a");
    const { writer: writerB } = addConnection("client-b", runtime);
    const scope = { agent_id: "agent-1", conversation_id: "conversation-1" };
    subscribeListenerConnection(runtime, "client-a", scope);
    subscribeListenerConnection(runtime, "client-b", scope);

    expect(selectListenerController(runtime, scope, writerB)?.id).toBe(
      "client-b",
    );
    expect(selectListenerController(runtime, scope)?.id).toBe("client-a");
    expect(selectListenerController(runtime, scope, writerA)?.id).toBe(
      "client-a",
    );
  });

  test("closing one connection removes only its subscriptions", () => {
    const { runtime } = addConnection("client-a");
    addConnection("client-b", runtime);
    const scope = { agent_id: "agent-1", conversation_id: "conversation-1" };
    subscribeListenerConnection(runtime, "client-a", scope);
    subscribeListenerConnection(runtime, "client-b", scope);

    closeListenerConnection(runtime, "client-b");

    expect(runtime.connections.has("client-b")).toBe(false);
    expect(runtime.connections.has("client-a")).toBe(true);
    expect(
      getSubscribedListenerConnections(runtime, scope).map(
        (connection) => connection.id,
      ),
    ).toEqual(["client-a"]);
  });

  test("the process transport broadcasts only to initialized live clients", () => {
    const { runtime, writer: writerA } = addConnection("client-a");
    const writerB = new MockTransport();
    openListenerConnection({
      runtime,
      connectionId: "client-b",
      writer: writerB,
      options: options("client-b"),
    });
    const { writer: writerC } = addConnection("client-c", runtime);
    writerC.open = false;

    getOrCreateProcessTransport(runtime).send("process-event");

    expect(writerA.sent).toEqual(["process-event"]);
    expect(writerB.sent).toEqual([]);
    expect(writerC.sent).toEqual([]);
  });
});
