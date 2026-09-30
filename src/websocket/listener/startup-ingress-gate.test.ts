import { expect, mock, test } from "bun:test";
import type WebSocket from "ws";
import { openListenerConnection } from "./connection";
import {
  createRuntime,
  startConnectedListenerRuntime,
  stopRuntime,
} from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { setActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import type { StartListenerOptions } from "./types";

class MockTransport {
  readonly kind = "local" as const;
  readonly sent: string[] = [];
  bufferedAmount = 0;

  isOpen(): boolean {
    return true;
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

test("gates every inbound frame until awaited connection startup completes", async () => {
  const runtime = createRuntime();
  const transport = new MockTransport();
  let releaseStartup!: () => void;
  const startupBlocked = new Promise<void>((resolve) => {
    releaseStartup = resolve;
  });
  const onWsEvent = mock(() => {});
  const options: StartListenerOptions = {
    connectionId: "connection-1",
    wsUrl: "local://test",
    deviceId: "device-1",
    connectionName: "test",
    onConnected: async () => startupBlocked,
    onDisconnected: () => {},
    onError: () => {},
    onWsEvent,
  };
  openListenerConnection({
    runtime,
    connectionId: options.connectionId,
    writer: transport as ListenerTransport,
    options,
  });
  runtime.onWsEvent = onWsEvent;
  setActiveRuntime(runtime);

  const handleMessage = createListenerMessageHandler({
    runtime,
    socket: transport as unknown as WebSocket,
    opts: options,
    processQueuedTurn: async () => {},
    fileCommandSession: { handle: () => false },
    getParsedRuntimeScope: () => null,
    replaySyncStateForRuntime: async () => {},
    getOrCreateScopedRuntime: () => {
      throw new Error("not used");
    },
    handleApprovalResponseInput: async () => false,
    handleChangeDeviceStateInput: async () => false,
    handleAbortMessageInput: async () => false,
    stampInboundUserMessageOtids: (incoming) => incoming,
    safeSocketSend: () => true,
    runDetachedListenerTask: () => {},
    trackListenerError: () => {},
    processIncomingMessage: async () => {},
  });

  try {
    const starting = startConnectedListenerRuntime(
      runtime,
      transport as ListenerTransport,
      options,
      async () => {},
      {
        startHeartbeat: false,
        startCronScheduler: false,
        startProcessServices: false,
        emitInitialState: false,
      },
    );
    const inbound = handleMessage(
      Buffer.from(JSON.stringify({ type: "pong" })),
    );
    await Promise.resolve();
    expect(onWsEvent).toHaveBeenCalledTimes(1);
    expect(runtime.lastPongAt).toBeNull();

    releaseStartup();
    await starting;
    await inbound;
    expect(runtime.lastPongAt).not.toBeNull();
    expect(onWsEvent).toHaveBeenCalledTimes(2);
  } finally {
    releaseStartup();
    stopRuntime(runtime, true);
    setActiveRuntime(null);
  }
});
