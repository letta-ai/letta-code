import { afterEach, describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import { __listenClientTestUtils } from "../../websocket/listen-client";
import { createListenerMessageHandler } from "../../websocket/listener/message-router";
import { parseServerLifecycleMessage } from "../../websocket/listener/protocol-inbound";
import type {
  IncomingMessage,
  ListenerRuntime,
  StartListenerOptions,
} from "../../websocket/listener/types";

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

function makeHandler(runtime: ListenerRuntime) {
  return createListenerMessageHandler({
    runtime,
    socket: {} as WebSocket,
    opts: makeListenerOptions(),
    processQueuedTurn: async () => {},
    fileCommandSession: { handle: () => false },
    getParsedRuntimeScope: () => null,
    replaySyncStateForRuntime: async () => {},
    getOrCreateScopedRuntime: () => {
      throw new Error("unused in lifecycle-frame tests");
    },
    handleApprovalResponseInput: async () => false,
    handleChangeDeviceStateInput: async () => false,
    handleAbortMessageInput: async () => false,
    stampInboundUserMessageOtids: (incoming: IncomingMessage) => incoming,
    safeSocketSend: () => false,
    runDetachedListenerTask: () => {},
    trackListenerError: () => {},
    wireChannelIngress: async () => {},
  });
}

describe("listener lifecycle frames", () => {
  afterEach(() => {
    __listenClientTestUtils.setActiveRuntime(null);
  });

  test("recognizes app-level pong frames", () => {
    expect(parseServerLifecycleMessage(Buffer.from('{"type":"pong"}'))).toEqual(
      { type: "pong" },
    );
  });

  test("logs app-level pong frames as lifecycle events", async () => {
    const runtime = __listenClientTestUtils.createListenerRuntime();
    const events: Array<{
      direction: "send" | "recv";
      label: "client" | "protocol" | "control" | "lifecycle";
      event: unknown;
    }> = [];
    runtime.onWsEvent = (direction, label, event) => {
      events.push({ direction, label, event });
    };
    __listenClientTestUtils.setActiveRuntime(runtime);

    await makeHandler(runtime)(Buffer.from('{"type":"pong"}'));

    expect(events).toEqual([
      { direction: "recv", label: "lifecycle", event: { type: "pong" } },
    ]);
  });

  test("still logs malformed frames as unparseable lifecycle events", async () => {
    const runtime = __listenClientTestUtils.createListenerRuntime();
    const events: Array<{
      direction: "send" | "recv";
      label: "client" | "protocol" | "control" | "lifecycle";
      event: unknown;
    }> = [];
    runtime.onWsEvent = (direction, label, event) => {
      events.push({ direction, label, event });
    };
    __listenClientTestUtils.setActiveRuntime(runtime);

    await makeHandler(runtime)(Buffer.from("not-json"));

    expect(events).toEqual([
      {
        direction: "recv",
        label: "lifecycle",
        event: { type: "_ws_unparseable", raw: "not-json" },
      },
    ]);
  });
});
