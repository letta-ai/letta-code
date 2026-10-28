import { afterEach, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { setActiveRuntime } from "./runtime";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerRuntime,
  StartListenerOptions,
} from "./types";

class MockSocket {
  readyState = WebSocket.OPEN;

  send(_payload: string): void {}
}

function makeListenerOptions(): StartListenerOptions {
  return {
    connectionId: "conn-test",
    wsUrl: "wss://example.test/ws",
    deviceId: "device-test",
    connectionName: "listener-test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for listener state");
}

function inputFrame(requestId: string, content: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: "input",
      request_id: requestId,
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      payload: {
        kind: "create_message",
        messages: [
          { role: "user", content, client_message_id: `cm-${requestId}` },
        ],
      },
    }),
  );
}

type Ack = { request_id: string; accepted: boolean; disposition?: string };

function setUpRouter(params: {
  processIncomingMessage: (
    incoming: IncomingMessage,
    transport: unknown,
    runtime: ConversationRuntime,
  ) => Promise<void>;
  processQueuedTurn: (incoming: IncomingMessage) => Promise<void>;
}): {
  runtime: ConversationRuntime;
  acks: Ack[];
  handleMessage: (data: Buffer) => Promise<void>;
} {
  const listener: ListenerRuntime = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const socket = new MockSocket();
  const connection = openListenerConnection({
    runtime: listener,
    connectionId: "conn-test",
    writer: socket as unknown as WebSocket,
    options: makeListenerOptions(),
  });
  markListenerConnectionInitialized(listener, "conn-test", connection);
  subscribeListenerConnection(listener, "conn-test", {
    agent_id: "agent-1",
    conversation_id: "conv-1",
  });
  setActiveRuntime(listener);
  const acks: Ack[] = [];
  const handleMessage = createListenerMessageHandler({
    runtime: listener,
    socket: socket as unknown as WebSocket,
    opts: makeListenerOptions(),
    processQueuedTurn: (queuedTurn) => params.processQueuedTurn(queuedTurn),
    fileCommandSession: { handle: () => false },
    getParsedRuntimeScope: () => null,
    replaySyncStateForRuntime: async () => {},
    getOrCreateScopedRuntime: () => runtime,
    handleApprovalResponseInput: async () => false,
    handleChangeDeviceStateInput: async () => false,
    handleAbortMessageInput: async () => false,
    stampInboundUserMessageOtids: (incoming) => incoming,
    safeSocketSend: (_target, payload) => {
      const message = payload as Ack & { type?: string };
      if (message.type === "input_accepted") {
        acks.push(message);
      }
      return true;
    },
    runDetachedListenerTask: () => {},
    trackListenerError: () => {},
    processIncomingMessage: (incoming, transport, conversation) =>
      params.processIncomingMessage(incoming, transport, conversation),
  });
  return { runtime, acks, handleMessage };
}

function contentOf(incoming: IncomingMessage): string[] {
  return incoming.messages.flatMap((message) =>
    "content" in message && typeof message.content === "string"
      ? [message.content]
      : [],
  );
}

afterEach(() => {
  setActiveRuntime(null);
});

describe("inputs that arrive while a direct dispatch is pending", () => {
  test("a second input is acknowledged before the pending direct turn begins", async () => {
    let releaseTurnA!: () => void;
    const turnAGate = new Promise<void>((resolve) => {
      releaseTurnA = resolve;
    });
    let turnAEntered = false;
    const { runtime, acks, handleMessage } = setUpRouter({
      // Turn A has been dispatched but is still in pre-turn setup, so the
      // lifecycle has not left idle yet.
      processIncomingMessage: async () => {
        turnAEntered = true;
        await turnAGate;
      },
      processQueuedTurn: async () => {},
    });

    await handleMessage(inputFrame("input-a", "turn A"));
    await waitFor(() => turnAEntered);
    expect(runtime.turnLifecycle.kind).toBe("idle");

    await handleMessage(inputFrame("input-b", "turn B"));
    await Bun.sleep(20);

    try {
      expect(acks).toContainEqual(
        expect.objectContaining({
          request_id: "input-b",
          accepted: true,
          disposition: "queued",
        }),
      );
    } finally {
      releaseTurnA();
      await runtime.messageQueue;
    }
  });

  test("the queued input runs as a follow-up after the pending direct turn", async () => {
    const order: string[] = [];
    let releaseTurnA!: () => void;
    const turnAGate = new Promise<void>((resolve) => {
      releaseTurnA = resolve;
    });
    let turnAEntered = false;
    const { runtime, acks, handleMessage } = setUpRouter({
      processIncomingMessage: async (incoming) => {
        turnAEntered = true;
        order.push(`direct:start:${contentOf(incoming).join(",")}`);
        await turnAGate;
        const lease = runtime.turnLifecycle.begin({
          origin: "message",
          workingDirectory: process.cwd(),
        });
        await Bun.sleep(5);
        runtime.turnLifecycle.finish(lease, "end_turn");
        order.push(`direct:end:${contentOf(incoming).join(",")}`);
      },
      processQueuedTurn: async (incoming) => {
        order.push(`queued:${contentOf(incoming).join(",")}`);
      },
    });

    await handleMessage(inputFrame("input-a", "turn A"));
    await waitFor(() => turnAEntered);
    await handleMessage(inputFrame("input-b", "turn B"));
    await waitFor(() => acks.some((ack) => ack.request_id === "input-b"));
    expect(order).toEqual(["direct:start:turn A"]);

    releaseTurnA();
    await waitFor(() => order.length === 3 && !runtime.queuePumpActive);

    expect(order).toEqual([
      "direct:start:turn A",
      "direct:end:turn A",
      "queued:turn B",
    ]);
    expect(acks).toEqual([
      expect.objectContaining({
        request_id: "input-a",
        accepted: true,
        disposition: "started",
      }),
      expect.objectContaining({
        request_id: "input-b",
        accepted: true,
        disposition: "queued",
      }),
    ]);
  });
});
