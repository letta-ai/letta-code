import { afterEach, describe, expect, mock, test } from "bun:test";
import WebSocket from "ws";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { scheduleQueuePump } from "./queue";
import { setActiveRuntime } from "./runtime";
import type { IncomingMessage, StartListenerOptions } from "./types";

class MockSocket {
  readyState = WebSocket.OPEN;
  sentPayloads: string[] = [];

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for listener state");
}

describe("listener message router ownership handoff", () => {
  afterEach(() => setActiveRuntime(null));

  test("a direct message that loses the idle race is queued and later drained", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socket = new MockSocket();
    const opts = makeListenerOptions();
    const processIncomingMessage = mock(async () => {});
    const processedTurns: IncomingMessage[] = [];
    const processQueuedTurn = mock(async (queuedTurn: IncomingMessage) => {
      processedTurns.push(queuedTurn);
    });
    const trackListenerError = mock(() => {});
    let releaseMessageQueue!: () => void;
    runtime.messageQueue = new Promise<void>((resolve) => {
      releaseMessageQueue = resolve;
    });
    setActiveRuntime(listener);

    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts,
      processQueuedTurn,
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
      trackListenerError,
      wireChannelIngress: async () => {},
      processIncomingMessage,
    });

    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
          payload: {
            kind: "create_message",
            messages: [{ role: "user", content: "do not drop me" }],
          },
        }),
      ),
    );
    const recoveryLease = runtime.turnLifecycle.begin({
      origin: "approval_recovery",
      workingDirectory: process.cwd(),
    });

    releaseMessageQueue();
    await runtime.messageQueue;
    await waitFor(
      () => !runtime.queuePumpActive && !runtime.queuePumpScheduled,
    );

    expect(processIncomingMessage).not.toHaveBeenCalled();
    expect(trackListenerError).not.toHaveBeenCalled();
    expect(runtime.queueRuntime.length).toBe(1);
    expect(runtime.queuedMessagesByItemId.size).toBe(1);

    runtime.turnLifecycle.finish(recoveryLease, "end_turn");
    scheduleQueuePump(
      runtime,
      socket as unknown as WebSocket,
      opts,
      processQueuedTurn,
    );
    await waitFor(
      () => processedTurns.length === 1 && runtime.queueRuntime.length === 0,
    );

    expect(processedTurns[0]?.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "do not drop me" }],
      },
    ]);
    expect(runtime.queuedMessagesByItemId.size).toBe(0);
  });
});
