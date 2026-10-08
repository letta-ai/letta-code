import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import {
  cleanupListenerConnection,
  closeListenerRuntimeConnections,
  createConnectionTurnProcessor,
} from "./connection-lifecycle";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import {
  commitInputDisposition,
  createAcceptedInputDispositionLedger,
  loadDurableQueuedInputEntries,
  ordinaryInputIdentity,
  reserveInputDisposition,
} from "./input-disposition";
import { createRuntime } from "./lifecycle";
import type { StartListenerOptions } from "./types";

class MockSocket extends EventEmitter {
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

  override removeAllListeners(event?: string | symbol): this {
    this.removeAllListenersCalls += 1;
    return event === undefined
      ? super.removeAllListeners()
      : super.removeAllListeners(event);
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
  test("a disconnected queued turn requeues its durable input", async () => {
    const runtime = createRuntime();
    runtime.acceptedInputDispositionLedger =
      createAcceptedInputDispositionLedger();
    runtime.restoreDurableQueuedInputs = () => 0;
    const scopedRuntime = getOrCreateScopedRuntime(
      runtime,
      "agent-1",
      "conversation-1",
    );
    const identity = ordinaryInputIdentity("cm-1");
    if (!identity) throw new Error("expected durable identity");
    const reservation = reserveInputDisposition(scopedRuntime, identity);
    if (reservation.kind !== "reserved")
      throw new Error("expected reservation");
    commitInputDisposition(scopedRuntime, reservation.reservation, "started", {
      incoming: {
        type: "message",
        agentId: "agent-1",
        conversationId: "conversation-1",
        messages: [{ role: "user", content: "hello" }],
        durableInputIdentities: [identity],
      },
    });
    scopedRuntime.dequeuedClientMessageIdsByBatchId.set("batch-1", ["cm-1"]);
    scopedRuntime.dequeuedInputIdentitiesByBatchId.set("batch-1", [identity]);

    await createConnectionTurnProcessor(runtime)(
      {
        type: "message",
        connectionId: "missing",
        agentId: "agent-1",
        conversationId: "conversation-1",
        messages: [{ role: "user", content: "hello" }],
      },
      {
        batchId: "batch-1",
        items: [],
        mergedCount: 1,
        queueLenAfter: 0,
      },
    );

    expect(scopedRuntime.dequeuedClientMessageIdsByBatchId.size).toBe(0);
    expect(loadDurableQueuedInputEntries(runtime)).toMatchObject([
      { disposition: "queued", payload: { identity } },
    ]);
  });

  test("disconnect detaches a queued origin without forgetting accepted input", () => {
    const runtime = createRuntime();
    runtime.acceptedInputDispositionLedger =
      createAcceptedInputDispositionLedger();
    const origin = new MockSocket();
    openListenerConnection({
      runtime,
      connectionId: "origin",
      writer: origin as never,
      options: makeOptions("origin"),
    });
    markListenerConnectionInitialized(runtime, "origin");
    const scope = { agent_id: "agent-1", conversation_id: "conversation-1" };
    subscribeListenerConnection(runtime, "origin", scope);
    const scopedRuntime = getOrCreateScopedRuntime(
      runtime,
      scope.agent_id,
      scope.conversation_id,
    );
    const identity = ordinaryInputIdentity("cm-queued");
    if (!identity) throw new Error("expected durable identity");
    const incoming = {
      type: "message" as const,
      connectionId: "origin",
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
      messages: [
        {
          role: "user" as const,
          content: "queued",
          client_message_id: "cm-queued",
        },
      ],
      durableInputIdentities: [identity],
    };
    const reservation = reserveInputDisposition(scopedRuntime, identity);
    if (reservation.kind !== "reserved")
      throw new Error("expected reservation");
    commitInputDisposition(scopedRuntime, reservation.reservation, "queued", {
      incoming,
    });
    expect(enqueueInboundUserMessage(scopedRuntime, incoming)).toBe(true);

    cleanupListenerConnection(runtime, "origin");

    expect(scopedRuntime.queueRuntime.length).toBe(1);
    expect([...scopedRuntime.queuedMessagesByItemId.values()][0]).toMatchObject(
      {
        connectionId: undefined,
        durableInputIdentities: [identity],
      },
    );
    expect(loadDurableQueuedInputEntries(runtime)).toMatchObject([
      { disposition: "queued", payload: { identity } },
    ]);
  });

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

  test("a resumable owner waits for its same-id replacement", () => {
    const runtime = createRuntime();
    for (const connectionId of ["origin", "peer"]) {
      openListenerConnection({
        runtime,
        connectionId,
        writer: new MockSocket() as never,
        options: makeOptions(connectionId),
      });
      markListenerConnectionInitialized(runtime, connectionId);
    }
    const scope = { agent_id: "agent-1", conversation_id: "conversation-1" };
    subscribeListenerConnection(runtime, "origin", scope);
    subscribeListenerConnection(runtime, "peer", scope);
    const scopedRuntime = getOrCreateScopedRuntime(
      runtime,
      scope.agent_id,
      scope.conversation_id,
    );
    const lease = scopedRuntime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    scopedRuntime.activeConnectionId = "origin";

    cleanupListenerConnection(runtime, "origin");

    expect(scopedRuntime.activeConnectionId).toBe("origin");
    expect(scopedRuntime.turnLifecycle.isCurrent(lease)).toBe(true);
    expect(runtime.connections.has("peer")).toBe(true);
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
    expect(socketA.listenerCount("error")).toBe(1);
    expect(socketB.listenerCount("error")).toBe(1);
  });

  test("suppressed shutdown absorbs a connecting WebSocket error until close", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const originalErrorCallback = mock(() => {});
    socket.on("error", originalErrorCallback);
    const emit = mock(socket.emit.bind(socket));
    socket.emit = emit as typeof socket.emit;
    const runtime = createRuntime();
    runtime.socket = socket;

    try {
      closeListenerRuntimeConnections(runtime, true);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (socket.readyState === WebSocket.CLOSED) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(emit.mock.calls.some(([event]) => event === "error")).toBe(true);
      expect(originalErrorCallback).not.toHaveBeenCalled();
      expect(socket.listenerCount("error")).toBe(0);
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
