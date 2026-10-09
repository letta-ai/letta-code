import { afterEach, describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
} from "@/websocket/listener/connection";
import { isListenerPongStale } from "@/websocket/listener/constants";
import { createListenerMessageHandler } from "@/websocket/listener/message-router";
import { parseServerLifecycleMessage } from "@/websocket/listener/protocol-inbound";
import type {
  IncomingMessage,
  ListenerRuntime,
  StartListenerOptions,
} from "@/websocket/listener/types";

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
  const opts = makeListenerOptions();
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send() {},
  } as unknown as WebSocket;
  const connection = openListenerConnection({
    runtime,
    connectionId: opts.connectionId,
    writer: socket,
    options: opts,
  });
  markListenerConnectionInitialized(runtime, opts.connectionId, connection);
  return createListenerMessageHandler({
    runtime,
    socket,
    opts,
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

  test("records lastPongAt when a pong frame arrives", async () => {
    const runtime = __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.setActiveRuntime(runtime);
    expect(runtime.lastPongAt).toBeNull();

    const before = Date.now();
    await makeHandler(runtime)(Buffer.from('{"type":"pong"}'));

    expect(runtime.lastPongAt).not.toBeNull();
    expect(runtime.lastPongAt as number).toBeGreaterThanOrEqual(before);
  });

  test("logs only redacted metadata for malformed lifecycle frames", async () => {
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
        event: { type: "_ws_unparseable" },
      },
    ]);
  });
});

describe("isListenerPongStale", () => {
  test("returns false before any pong is recorded", () => {
    expect(isListenerPongStale(null, 1_000_000, 90_000)).toBe(false);
  });

  test("returns false when a pong arrived within the timeout", () => {
    const now = 1_000_000;
    expect(isListenerPongStale(now - 30_000, now, 90_000)).toBe(false);
    // Exactly at the boundary is not yet stale.
    expect(isListenerPongStale(now - 90_000, now, 90_000)).toBe(false);
  });

  test("returns true once the timeout is exceeded", () => {
    const now = 1_000_000;
    expect(isListenerPongStale(now - 90_001, now, 90_000)).toBe(true);
    expect(isListenerPongStale(now - 300_000, now, 90_000)).toBe(true);
  });
});
