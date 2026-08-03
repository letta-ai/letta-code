import { afterEach, describe, expect, mock, test } from "bun:test";
import WebSocket from "ws";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { setActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import type { IncomingMessage, StartListenerOptions } from "./types";

class MockSocket {
  readyState = WebSocket.OPEN;
  send(): void {}
}

function makeOptions(): StartListenerOptions {
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

function setup() {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const socket = new MockSocket();
  listener.transport = socket as unknown as ListenerTransport;
  const events: Array<Record<string, unknown>> = [];
  listener.streamObservers = new Set([
    (event) => events.push(event as Record<string, unknown>),
  ]);
  const processIncomingMessage = mock(async () => {});
  const handleMessage = createListenerMessageHandler({
    runtime: listener,
    socket: socket as unknown as WebSocket,
    opts: makeOptions(),
    processQueuedTurn: async (_turn: IncomingMessage) => {},
    fileCommandSession: { handle: () => false },
    getParsedRuntimeScope: () => null,
    replaySyncStateForRuntime: async () => {},
    getOrCreateScopedRuntime: () => runtime,
    handleApprovalResponseInput: async () => false,
    handleChangeDeviceStateInput: async () => false,
    handleAbortMessageInput: async () => false,
    stampInboundUserMessageOtids: (incoming) => incoming,
    safeSocketSend: () => true,
    runDetachedListenerTask: () => {},
    trackListenerError: () => {},
    wireChannelIngress: async () => {},
    processIncomingMessage,
  });
  setActiveRuntime(listener);
  return { runtime, events, processIncomingMessage, handleMessage };
}

function command(content = "hello") {
  return Buffer.from(
    JSON.stringify({
      type: "input",
      request_id: crypto.randomUUID(),
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      payload: {
        kind: "create_message",
        messages: [
          {
            role: "user",
            content,
            client_message_id: "cm-1",
          },
        ],
      },
    }),
  );
}

describe("listener input admission state", () => {
  afterEach(() => setActiveRuntime(null));

  test("direct admission is correlated and retry does not execute twice", async () => {
    const { runtime, events, processIncomingMessage, handleMessage } = setup();

    await handleMessage(command());
    await runtime.messageQueue;
    await handleMessage(command());
    await runtime.messageQueue;

    expect(processIncomingMessage).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.type === "runtime_input_state"),
    ).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      client_message_id: "cm-1",
      status: "admitted",
      admission: "direct",
    });
  });

  test("busy input reports queued admission and correlated drop", async () => {
    const { runtime, events, processIncomingMessage, handleMessage } = setup();
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });

    await handleMessage(command());
    expect(processIncomingMessage).not.toHaveBeenCalled();
    expect(runtime.queueRuntime.length).toBe(1);
    expect(
      events.filter((event) => event.type === "runtime_input_state").at(-1),
    ).toMatchObject({
      client_message_id: "cm-1",
      status: "admitted",
      admission: "queued",
    });

    runtime.queueRuntime.clear("error");
    expect(
      events.filter((event) => event.type === "runtime_input_state").at(-1),
    ).toMatchObject({
      client_message_id: "cm-1",
      status: "dropped",
    });
    runtime.turnLifecycle.finish(lease, "end_turn");
  });
});
