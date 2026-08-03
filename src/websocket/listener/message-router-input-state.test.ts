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

function command(content = "hello", clientMessageIds = ["cm-1"]) {
  return Buffer.from(
    JSON.stringify({
      type: "input",
      request_id: crypto.randomUUID(),
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      payload: {
        kind: "create_message",
        messages: clientMessageIds.map((clientMessageId, index) => ({
          role: "user",
          content: index === 0 ? content : `${content} ${index + 1}`,
          client_message_id: clientMessageId,
        })),
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

    await handleMessage(command("queued", ["cm-a", "cm-b"]));
    expect(processIncomingMessage).not.toHaveBeenCalled();
    expect(runtime.queueRuntime.length).toBe(1);
    expect(
      events
        .filter(
          (event) =>
            event.type === "runtime_input_state" && event.status === "admitted",
        )
        .map((event) => event.client_message_id),
    ).toEqual(["cm-a", "cm-b"]);

    runtime.queueRuntime.clear("error");
    expect(
      events
        .filter(
          (event) =>
            event.type === "runtime_input_state" && event.status === "dropped",
        )
        .map((event) => event.client_message_id),
    ).toEqual(["cm-a", "cm-b"]);
    runtime.turnLifecycle.finish(lease, "end_turn");
  });

  test("explicit queue removal reports a correlated drop", async () => {
    const { runtime, events, handleMessage } = setup();
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    await handleMessage(command());

    const queued = runtime.queueRuntime.items[0];
    expect(queued).toBeDefined();
    runtime.queueRuntime.removeItem(queued?.id ?? "");

    expect(
      events.filter((event) => event.type === "runtime_input_state").at(-1),
    ).toMatchObject({
      client_message_id: "cm-1",
      status: "dropped",
      error: "removed",
    });
    runtime.turnLifecycle.finish(lease, "end_turn");
  });

  test("hard-limit rejection drops every identity exactly once", async () => {
    const { runtime, events, handleMessage } = setup();
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    for (let index = 0; index < 300; index += 1) {
      expect(
        runtime.queueRuntime.enqueue({
          kind: "approval_result",
          source: "system",
          text: `barrier-${index}`,
          agentId: "agent-1",
          conversationId: "conv-1",
        } as Parameters<typeof runtime.queueRuntime.enqueue>[0]),
      ).not.toBeNull();
    }

    await handleMessage(command("overflow", ["cm-a", "cm-b"]));

    const inputEvents = events.filter(
      (event) => event.type === "runtime_input_state",
    );
    expect(inputEvents).toHaveLength(2);
    expect(inputEvents.map((event) => event.client_message_id)).toEqual([
      "cm-a",
      "cm-b",
    ]);
    expect(inputEvents.every((event) => event.status === "dropped")).toBe(true);
    runtime.queueRuntime.clear("shutdown");
    runtime.turnLifecycle.finish(lease, "end_turn");
  });
});
