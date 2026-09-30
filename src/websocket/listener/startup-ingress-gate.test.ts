import { expect, mock, test } from "bun:test";
import type WebSocket from "ws";
import {
  closeListenerConnection,
  markListenerConnectionInitialized,
  openListenerConnection,
} from "./connection";
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

  constructor(private readonly onSend?: () => void) {}

  isOpen(): boolean {
    return true;
  }

  send(data: string): void {
    this.onSend?.();
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

test("emits initial state before opening the inbound startup gate", async () => {
  const runtime = createRuntime();
  const connectionId = "initial-sync";
  const initializedDuringSync: boolean[] = [];
  const transport = new MockTransport(() => {
    initializedDuringSync.push(
      runtime.connections.get(connectionId)?.initialized ?? false,
    );
  });
  const options: StartListenerOptions = {
    connectionId,
    wsUrl: "local://test",
    deviceId: "device-1",
    connectionName: "test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  openListenerConnection({
    runtime,
    connectionId,
    writer: transport,
    options,
  });
  setActiveRuntime(runtime);

  try {
    await startConnectedListenerRuntime(
      runtime,
      transport,
      options,
      async () => {},
      {
        startHeartbeat: false,
        startCronScheduler: false,
        startProcessServices: false,
      },
    );

    expect(initializedDuringSync.length).toBeGreaterThan(0);
    expect(initializedDuringSync).toEqual(
      initializedDuringSync.map(() => false),
    );
    expect(runtime.connections.get(connectionId)?.initialized).toBe(true);
  } finally {
    stopRuntime(runtime, true);
    setActiveRuntime(null);
  }
});

test("stale startup cannot initialize a replacement with the same id", async () => {
  const runtime = createRuntime();
  const firstTransport = new MockTransport();
  const replacementTransport = new MockTransport();
  let releaseFirstStartup!: () => void;
  const firstStartupBlocked = new Promise<void>((resolve) => {
    releaseFirstStartup = resolve;
  });
  const options: StartListenerOptions = {
    connectionId: "reused-connection",
    wsUrl: "local://test",
    deviceId: "device-1",
    connectionName: "test",
    onConnected: async () => firstStartupBlocked,
    onDisconnected: () => {},
    onError: () => {},
  };
  const firstConnection = openListenerConnection({
    runtime,
    connectionId: options.connectionId,
    writer: firstTransport,
    options,
  });
  const handleFirstMessage = createListenerMessageHandler({
    runtime,
    socket: firstTransport as unknown as WebSocket,
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
  setActiveRuntime(runtime);

  try {
    const firstStartup = startConnectedListenerRuntime(
      runtime,
      firstTransport,
      options,
      async () => {},
      {
        startHeartbeat: false,
        startCronScheduler: false,
        startProcessServices: false,
        emitInitialState: false,
      },
    );
    await Promise.resolve();

    expect(closeListenerConnection(runtime, options.connectionId)).toBe(
      firstConnection,
    );
    const replacement = openListenerConnection({
      runtime,
      connectionId: options.connectionId,
      writer: replacementTransport,
      options: { ...options, onConnected: () => {} },
    });

    releaseFirstStartup();
    await firstStartup;

    expect(firstConnection.initialized).toBe(false);
    expect(replacement.initialized).toBe(false);
    markListenerConnectionInitialized(
      runtime,
      options.connectionId,
      replacement,
    );
    expect(replacement.initialized).toBe(true);

    await handleFirstMessage(Buffer.from(JSON.stringify({ type: "pong" })));
    expect(runtime.lastPongAt).toBeNull();
  } finally {
    releaseFirstStartup();
    stopRuntime(runtime, true);
    setActiveRuntime(null);
  }
});
