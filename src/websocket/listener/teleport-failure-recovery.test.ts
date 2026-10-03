import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { readdirSync, utimesSync } from "node:fs";
import WebSocket from "ws";
import { settingsManager } from "@/settings-manager";
import { TestDirectory } from "@/test-utils/test-fs";
import {
  getStoredClientPreferences,
  replaceClientPreferences,
} from "@/tools/client-preferences";
import type { TeleportContinuation } from "@/types/protocol_v2";
import {
  closeListenerConnection,
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { setActiveRuntime } from "./runtime";
import {
  claimPendingTeleportAtBoundary,
  clearPriorReadyTeleports,
  finishTeleport,
  handleTeleportRequest,
  isRuntimeTeleportPending,
  setTeleportInterruptedTurnStoreForTests,
} from "./teleport";
import {
  createTeleportRecoveryStore,
  type TeleportRecoveryStore,
} from "./teleport-recovery-store";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerRuntime,
  StartListenerOptions,
} from "./types";

class MockSocket {
  readonly bufferedAmount = 0;
  readonly readyState = WebSocket.OPEN;
  readonly sent: unknown[] = [];

  isOpen(): boolean {
    return true;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

const interruptedStores = new WeakMap<
  ListenerRuntime,
  ReturnType<typeof createInterruptedTurnStore>
>();

function makeOptions(
  connectionId = "source",
  deviceId = "source-device",
): StartListenerOptions {
  return {
    connectionId,
    wsUrl: "ws://app-server.test",
    deviceId,
    connectionName: "Source",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

function openSourceConnection(
  listener: ListenerRuntime,
  socket: MockSocket,
  connectionId = "source",
  deviceId = "source-device",
): void {
  if (!interruptedStores.has(listener)) {
    const store = createInterruptedTurnStore(
      `${stateDirectory.path}/interrupted-turns`,
    );
    interruptedStores.set(listener, store);
    setTeleportInterruptedTurnStoreForTests(listener, store);
  }
  openListenerConnection({
    runtime: listener,
    connectionId,
    writer: socket as never,
    options: makeOptions(connectionId, deviceId),
  });
  subscribeListenerConnection(listener, connectionId, {
    agent_id: "agent-1",
    conversation_id: "conversation-1",
  });
  markListenerConnectionInitialized(listener, connectionId);
}

function prepareSourceTeleport(
  listener: ListenerRuntime,
  runtime: ConversationRuntime,
  socket: MockSocket,
  continuation?: TeleportContinuation,
  connectionId = "source",
): void {
  openSourceConnection(listener, socket, connectionId);
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  handleTeleportRequest({
    listener,
    connectionId,
    command: {
      type: "teleport_request",
      request_id: "teleport-1",
      teleport_id: "teleport-1",
      runtime: { agent_id: "agent-1", conversation_id: "conversation-1" },
      target: {
        connection_id: "target",
        device_id: "target-device",
        connection_name: "Target",
      },
    },
  });
  const pending = claimPendingTeleportAtBoundary({
    listener,
    agentId: "agent-1",
    conversationId: "conversation-1",
    activeTurn: true,
    ...(continuation ? { continuation } : {}),
  });
  if (!pending) throw new Error("Teleport did not reach the source boundary");
  interruptedStores.get(listener)?.write({
    agentId: "agent-1",
    conversationId: "conversation-1",
    runId: "run-source",
    toolCallIds: [],
    results: [],
    requestOtid: "source-request",
    workingDirectory: process.cwd(),
  });
  finishTeleport(runtime, lease, pending);
}

async function deliverTeleportFailure(params: {
  listener: ListenerRuntime;
  runtime: ConversationRuntime;
  socket: MockSocket;
  processIncomingMessage: (incoming: IncomingMessage) => Promise<void>;
  error: string;
  requestId?: string;
  acceptInput?: boolean;
  teleportId?: string;
  agentId?: string;
  conversationId?: string;
  recoveryStore?: TeleportRecoveryStore;
  connectionId?: string;
}): Promise<void> {
  let detachedTask: Promise<void> | undefined;
  const handleMessage = createListenerMessageHandler({
    runtime: params.listener,
    socket: params.socket as unknown as WebSocket,
    connectionId: params.connectionId,
    opts: makeOptions(params.connectionId),
    processQueuedTurn: async () => {},
    fileCommandSession: { handle: () => false },
    getParsedRuntimeScope: () => null,
    replaySyncStateForRuntime: async () => {},
    getOrCreateScopedRuntime: () => params.runtime,
    handleApprovalResponseInput: async () => false,
    handleChangeDeviceStateInput: async () => false,
    handleAbortMessageInput: async () => false,
    stampInboundUserMessageOtids: (incoming) => incoming,
    safeSocketSend: () => true,
    runDetachedListenerTask: (_name, task) => {
      detachedTask = task();
    },
    trackListenerError: () => {},
    processIncomingMessage: async (...args) => {
      const processing = params.processIncomingMessage(args[0]);
      if (params.acceptInput !== false) args[8]?.();
      await processing;
    },
    ...(params.recoveryStore
      ? { teleportRecoveryStore: params.recoveryStore }
      : {}),
  });

  await handleMessage(
    Buffer.from(
      JSON.stringify({
        type: "teleport_failed",
        ...(params.requestId ? { request_id: params.requestId } : {}),
        teleport_id: params.teleportId ?? "teleport-1",
        runtime: {
          agent_id: params.agentId ?? "agent-1",
          conversation_id: params.conversationId ?? "conversation-1",
        },
        error: params.error,
      }),
    ),
  );
  await detachedTask;
}

let stateDirectory: TestDirectory;
let previousHome: string | undefined;
let previousListenerStateDirectory: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  previousListenerStateDirectory = process.env.LETTA_LISTENER_STATE_DIR;
  stateDirectory = new TestDirectory();
  process.env.HOME = stateDirectory.path;
  process.env.LETTA_LISTENER_STATE_DIR = stateDirectory.path;
});

afterEach(() => {
  setActiveRuntime(null);
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousListenerStateDirectory === undefined)
    delete process.env.LETTA_LISTENER_STATE_DIR;
  else process.env.LETTA_LISTENER_STATE_DIR = previousListenerStateDirectory;
  stateDirectory.cleanup();
});

test("stale turn leases cannot persist yielded Teleport authority", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const socket = new MockSocket();
  openSourceConnection(listener, socket);
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  handleTeleportRequest({
    listener,
    connectionId: "source",
    command: {
      type: "teleport_request",
      request_id: "teleport-stale",
      teleport_id: "teleport-stale",
      runtime: { agent_id: "agent-1", conversation_id: "conversation-1" },
      target: {
        connection_id: "target",
        device_id: "target-device",
        connection_name: "Target",
      },
    },
  });
  const pending = claimPendingTeleportAtBoundary({
    listener,
    agentId: "agent-1",
    conversationId: "conversation-1",
    activeTurn: true,
  });
  if (!pending) throw new Error("Teleport did not reach the source boundary");
  runtime.turnLifecycle.reset();

  expect(finishTeleport(runtime, lease, pending).finished).toBe(false);
  expect(createTeleportRecoveryStore().read("teleport-stale")).toBeNull();
  handleTeleportRequest({
    listener,
    connectionId: "source",
    command: {
      type: "teleport_request",
      request_id: "teleport-stale-retry",
      teleport_id: "teleport-stale",
      runtime: { agent_id: "agent-1", conversation_id: "conversation-1" },
      target: {
        connection_id: "target",
        device_id: "target-device",
        connection_name: "Target",
      },
    },
  });
  expect(
    socket.sent.filter(
      (message) => (message as { type?: string }).type === "teleport_ready",
    ),
  ).toHaveLength(0);
});

test("failed same-runtime teleport keeps the source preference snapshot", async () => {
  const directory = new TestDirectory();
  const oldHome = process.env.HOME;
  await settingsManager.reset();
  process.env.HOME = directory.path;
  try {
    await settingsManager.initialize();
    const preferences = { toolset: { include: ["AskUserQuestion"] } };
    replaceClientPreferences("agent-1", "conversation-1", preferences);
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conversation-1",
    );
    const socket = new MockSocket();
    setActiveRuntime(listener);
    prepareSourceTeleport(listener, runtime, socket);
    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        type: "teleport_ready",
        client_preferences: preferences,
      }),
    );
    await deliverTeleportFailure({
      listener,
      runtime,
      socket,
      error: "Destination unavailable",
      processIncomingMessage: async (incoming) => {
        expect(incoming.clientPreferences).toBeUndefined();
        expect(
          getStoredClientPreferences(
            incoming.agentId ?? null,
            incoming.conversationId,
          ),
        ).toEqual(preferences);
      },
    });
    expect(getStoredClientPreferences("agent-1", "conversation-1")).toEqual(
      preferences,
    );
  } finally {
    await settingsManager.reset();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    directory.cleanup();
  }
});

test("old teleport failure without request_id recovers without an ack", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const socket = new MockSocket();
  const received: IncomingMessage[] = [];
  const processIncomingMessage = mock(async (incoming: IncomingMessage) => {
    received.push(incoming);
  });
  setActiveRuntime(listener);
  prepareSourceTeleport(listener, runtime, socket);

  await deliverTeleportFailure({
    listener,
    runtime,
    socket,
    processIncomingMessage,
    error: "404 Agent <missing> & unavailable",
  });

  expect(processIncomingMessage).toHaveBeenCalledTimes(1);
  expect(received[0]).toMatchObject({
    type: "message",
    connectionId: "source",
    agentId: "agent-1",
    conversationId: "conversation-1",
    messages: [
      {
        role: "user",
        content:
          "<system-reminder>Teleportation failed.\n\nError: 404 Agent &lt;missing&gt; &amp; unavailable\n\nContinue the existing task from this environment now.</system-reminder>",
        otid: "teleport-1:failed",
      },
    ],
  });
  expect(socket.sent).toContainEqual(
    expect.objectContaining({
      type: "stream_delta",
      runtime: {
        agent_id: "agent-1",
        conversation_id: "conversation-1",
      },
      delta: expect.objectContaining({
        message_type: "loop_error",
        message: "Teleport failed: 404 Agent <missing> & unavailable",
        stop_reason: "error",
        is_terminal: false,
      }),
    }),
  );
  expect(
    socket.sent.some(
      (message) =>
        (message as { type?: string }).type === "teleport_failed_ack",
    ),
  ).toBe(false);
  expect(listener.pendingTeleports?.has("teleport-1")).toBe(false);
});

test("teleport failure acks after durable input acceptance without waiting for completion", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const socket = new MockSocket();
  let startRecovery: (() => void) | undefined;
  const recoveryStarted = new Promise<void>((resolve) => {
    startRecovery = resolve;
  });
  let finishRecovery: (() => void) | undefined;
  const recoveryFinished = new Promise<void>((resolve) => {
    finishRecovery = resolve;
  });
  const processIncomingMessage = mock(async () => {
    startRecovery?.();
    await recoveryFinished;
  });
  setActiveRuntime(listener);
  prepareSourceTeleport(listener, runtime, socket);

  const delivery = deliverTeleportFailure({
    listener,
    runtime,
    socket,
    requestId: "failure-1",
    error: "Destination unavailable",
    processIncomingMessage,
  });
  await recoveryStarted;
  await deliverTeleportFailure({
    listener,
    runtime,
    socket,
    requestId: "failure-2",
    error: "Destination unavailable",
    processIncomingMessage,
  });

  expect(processIncomingMessage).toHaveBeenCalledTimes(1);
  expect(
    socket.sent
      .filter(
        (message) =>
          (message as { type?: string }).type === "teleport_failed_ack",
      )
      .map((message) => (message as { request_id: string }).request_id),
  ).toEqual(["failure-1", "failure-2"]);
  expect(isRuntimeTeleportPending(listener, "agent-1", "conversation-1")).toBe(
    false,
  );

  finishRecovery?.();
  await delivery;
});

test("duplicate teleport failure re-acks without applying recovery twice", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const socket = new MockSocket();
  const processIncomingMessage = mock(async () => {});
  setActiveRuntime(listener);
  prepareSourceTeleport(listener, runtime, socket);

  await deliverTeleportFailure({
    listener,
    runtime,
    socket,
    requestId: "failure-1",
    error: "Destination unavailable",
    processIncomingMessage,
  });
  await deliverTeleportFailure({
    listener,
    runtime,
    socket,
    requestId: "failure-2",
    error: "Destination unavailable",
    processIncomingMessage,
  });

  expect(processIncomingMessage).toHaveBeenCalledTimes(1);
  expect(
    socket.sent
      .filter(
        (message) =>
          (message as { type?: string }).type === "teleport_failed_ack",
      )
      .map((message) => (message as { request_id: string }).request_id),
  ).toEqual(["failure-1", "failure-2"]);
});

test("failed recovery sends no ack and remains retryable", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const socket = new MockSocket();
  let attempts = 0;
  const processIncomingMessage = mock(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("apply failed");
  });
  setActiveRuntime(listener);
  prepareSourceTeleport(listener, runtime, socket);

  await expect(
    deliverTeleportFailure({
      listener,
      runtime,
      socket,
      requestId: "failure-1",
      error: "Destination unavailable",
      processIncomingMessage,
      acceptInput: false,
    }),
  ).rejects.toThrow("apply failed");
  expect(
    socket.sent.some(
      (message) =>
        (message as { type?: string }).type === "teleport_failed_ack",
    ),
  ).toBe(false);
  expect(listener.pendingTeleports?.get("teleport-1")?.failureRecovery).toBe(
    undefined,
  );

  await deliverTeleportFailure({
    listener,
    runtime,
    socket,
    requestId: "failure-2",
    error: "Destination unavailable",
    processIncomingMessage,
  });

  expect(processIncomingMessage).toHaveBeenCalledTimes(2);
  expect(socket.sent).toContainEqual(
    expect.objectContaining({
      type: "teleport_failed_ack",
      request_id: "failure-2",
      teleport_id: "teleport-1",
    }),
  );
});

test("terminal teleport failure preserves approval results before resuming", async () => {
  const approvals: TeleportContinuation["approvals"] = [
    {
      type: "tool",
      tool_call_id: "call-1",
      status: "success",
      tool_return: '{"status":"waiting_for_source"}',
    },
  ];
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const socket = new MockSocket();
  const received: IncomingMessage[] = [];
  const processIncomingMessage = mock(async (incoming: IncomingMessage) => {
    received.push(incoming);
  });
  setActiveRuntime(listener);
  prepareSourceTeleport(listener, runtime, socket, { approvals });

  await deliverTeleportFailure({
    listener,
    runtime,
    socket,
    processIncomingMessage,
    error: "Target failed to start",
  });

  expect(received[0]?.messages).toEqual([
    {
      type: "approval",
      approvals,
      otid: "teleport-1",
    },
    {
      role: "user",
      content:
        "<system-reminder>Teleportation failed.\n\nError: Target failed to start\n\nContinue the existing task from this environment now.</system-reminder>",
      otid: "teleport-1:failed",
    },
  ]);
});

test("durable accepted recovery re-acks after listener restart without replay", async () => {
  const firstListener = createRuntime();
  const firstRuntime = getOrCreateScopedRuntime(
    firstListener,
    "agent-1",
    "conversation-1",
  );
  const firstSocket = new MockSocket();
  setActiveRuntime(firstListener);
  prepareSourceTeleport(
    firstListener,
    firstRuntime,
    firstSocket,
    undefined,
    "app-server-5",
  );
  await deliverTeleportFailure({
    listener: firstListener,
    runtime: firstRuntime,
    socket: firstSocket,
    connectionId: "app-server-5",
    requestId: "failure-1",
    error: "Destination unavailable",
    processIncomingMessage: async () => {},
  });

  const restartedListener = createRuntime();
  const restartedRuntime = getOrCreateScopedRuntime(
    restartedListener,
    "agent-1",
    "conversation-1",
  );
  const restartedSocket = new MockSocket();
  openSourceConnection(restartedListener, restartedSocket, "app-server-0");
  setActiveRuntime(restartedListener);
  const processIncomingMessage = mock(async () => {});
  await deliverTeleportFailure({
    listener: restartedListener,
    runtime: restartedRuntime,
    socket: restartedSocket,
    connectionId: "app-server-0",
    requestId: "failure-after-restart",
    error: "Destination unavailable",
    processIncomingMessage,
  });

  expect(processIncomingMessage).not.toHaveBeenCalled();
  expect(restartedSocket.sent).toContainEqual(
    expect.objectContaining({
      type: "teleport_failed_ack",
      request_id: "failure-after-restart",
    }),
  );
});

test("same-process app-server reconnect routes durable unwind through the new socket", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const oldSocket = new MockSocket();
  setActiveRuntime(listener);
  prepareSourceTeleport(
    listener,
    runtime,
    oldSocket,
    undefined,
    "app-server-5",
  );
  closeListenerConnection(listener, "app-server-5");
  const reconnectedSocket = new MockSocket();
  openSourceConnection(listener, reconnectedSocket, "app-server-6");
  const seenConnectionIds: Array<string | undefined> = [];

  await deliverTeleportFailure({
    listener,
    runtime,
    socket: reconnectedSocket,
    connectionId: "app-server-6",
    requestId: "failure-after-reconnect",
    error: "Destination unavailable",
    processIncomingMessage: async (incoming) => {
      seenConnectionIds.push(incoming.connectionId);
    },
  });

  expect(seenConnectionIds).toEqual(["app-server-6"]);
  expect(reconnectedSocket.sent).toContainEqual(
    expect.objectContaining({
      type: "teleport_failed_ack",
      request_id: "failure-after-reconnect",
    }),
  );
});

test("yield proof survives beyond five minutes and newer Teleport eviction", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const socket = new MockSocket();
  setActiveRuntime(listener);
  prepareSourceTeleport(listener, runtime, socket);
  const store = createTeleportRecoveryStore();
  const proof = store.read("teleport-1");
  if (!proof) throw new Error("missing durable Teleport proof");
  store.write({ ...proof, recordedAt: Date.now() - 6 * 60_000 });
  clearPriorReadyTeleports({
    listener,
    agentId: "agent-1",
    conversationId: "conversation-1",
    currentTeleportId: "teleport-2",
  });
  expect(listener.pendingTeleports?.has("teleport-1")).toBe(false);

  const processIncomingMessage = mock(async () => {});
  await deliverTeleportFailure({
    listener,
    runtime,
    socket,
    requestId: "failure-late",
    error: "Destination unavailable",
    processIncomingMessage,
  });

  expect(processIncomingMessage).toHaveBeenCalledTimes(1);
  expect(socket.sent).toContainEqual(
    expect.objectContaining({
      type: "teleport_failed_ack",
      request_id: "failure-late",
    }),
  );
});

test("recovery proof is pruned only after outliving the Cloud retry window", () => {
  const directory = `${stateDirectory.path}/expiry-ledger`;
  const store = createTeleportRecoveryStore(directory);
  const expiredAt = Date.now() - 25 * 60 * 60_000;
  store.write({
    teleportId: "teleport-expired",
    agentId: "agent-1",
    conversationId: "conversation-1",
    sourceDeviceId: "source-device",
    sourceSessionId: "listen-original",
    disposition: "yielded",
    phase: "ready",
    readiness: {
      client_preferences: getStoredClientPreferences(
        "agent-1",
        "conversation-1",
      ),
      success: true,
      active_turn: true,
      mode: "standard",
    },
    recordedAt: expiredAt,
    recoveryAcceptedAt: expiredAt,
  });
  const [recordName] = readdirSync(directory).filter((name) =>
    name.endsWith(".json"),
  );
  if (!recordName) throw new Error("missing recovery record file");
  utimesSync(`${directory}/${recordName}`, expiredAt / 1000, expiredAt / 1000);

  expect(store.read("teleport-expired")).toBeNull();
});

test("exact Teleport key and runtime mismatches do not recover or ack", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const socket = new MockSocket();
  setActiveRuntime(listener);
  prepareSourceTeleport(listener, runtime, socket);
  const processIncomingMessage = mock(async () => {});

  await deliverTeleportFailure({
    listener,
    runtime,
    socket,
    requestId: "wrong-key",
    teleportId: "teleport-other",
    error: "Destination unavailable",
    processIncomingMessage,
  });
  await deliverTeleportFailure({
    listener,
    runtime,
    socket,
    requestId: "wrong-runtime",
    agentId: "agent-other",
    error: "Destination unavailable",
    processIncomingMessage,
  });

  expect(processIncomingMessage).not.toHaveBeenCalled();
  expect(
    socket.sent.some(
      (message) =>
        (message as { type?: string }).type === "teleport_failed_ack",
    ),
  ).toBe(false);
});

test("ledger write failure after Core acceptance retries the same recovery OTID", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const socket = new MockSocket();
  setActiveRuntime(listener);
  prepareSourceTeleport(listener, runtime, socket);
  const durableStore = createTeleportRecoveryStore();
  let failAcceptedWrite = true;
  const crashingStore: TeleportRecoveryStore = {
    read: (teleportId) => durableStore.read(teleportId),
    write: (record) => {
      if (record.recoveryAcceptedAt && failAcceptedWrite) {
        failAcceptedWrite = false;
        throw new Error("simulated ledger crash window");
      }
      durableStore.write(record);
    },
    remove: (teleportId) => durableStore.remove(teleportId),
  };
  const visibleRecoveryOtids = new Set<string>();
  const processIncomingMessage = mock(async (incoming: IncomingMessage) => {
    const user = incoming.messages.find((message) => "content" in message);
    if (user?.otid) visibleRecoveryOtids.add(user.otid);
  });

  await expect(
    deliverTeleportFailure({
      listener,
      runtime,
      socket,
      requestId: "failure-crash",
      error: "Destination unavailable",
      processIncomingMessage,
      recoveryStore: crashingStore,
    }),
  ).rejects.toThrow("simulated ledger crash window");
  expect(
    socket.sent.some(
      (message) =>
        (message as { request_id?: string }).request_id === "failure-crash",
    ),
  ).toBe(false);

  await deliverTeleportFailure({
    listener,
    runtime,
    socket,
    requestId: "failure-retry",
    error: "Destination unavailable",
    processIncomingMessage,
    recoveryStore: crashingStore,
  });
  expect(processIncomingMessage).toHaveBeenCalledTimes(2);
  expect(visibleRecoveryOtids).toEqual(new Set(["teleport-1:failed"]));
  expect(socket.sent).toContainEqual(
    expect.objectContaining({
      type: "teleport_failed_ack",
      request_id: "failure-retry",
    }),
  );
});

test("matching source-rejected Teleport acks as a no-op but mismatch does not", async () => {
  const store = createTeleportRecoveryStore();
  store.write({
    teleportId: "teleport-rejected",
    agentId: "agent-1",
    conversationId: "conversation-1",
    sourceDeviceId: "source-device",
    sourceSessionId: "listen-original",
    disposition: "rejected",
    phase: "ready",
    readiness: {
      client_preferences: getStoredClientPreferences(
        "agent-1",
        "conversation-1",
      ),
      success: false,
      active_turn: false,
      mode: "standard",
      error: "Conversation already has a teleport pending",
    },
    recordedAt: Date.now(),
  });
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const socket = new MockSocket();
  openSourceConnection(listener, socket);
  setActiveRuntime(listener);
  const processIncomingMessage = mock(async () => {});

  await deliverTeleportFailure({
    listener,
    runtime,
    socket,
    teleportId: "teleport-rejected",
    requestId: "rejected-match",
    error: "Destination unavailable",
    processIncomingMessage,
  });
  await deliverTeleportFailure({
    listener,
    runtime,
    socket,
    teleportId: "teleport-rejected",
    requestId: "rejected-mismatch",
    conversationId: "conversation-other",
    error: "Destination unavailable",
    processIncomingMessage,
  });

  expect(processIncomingMessage).not.toHaveBeenCalled();
  expect(
    socket.sent
      .filter(
        (message) =>
          (message as { type?: string }).type === "teleport_failed_ack",
      )
      .map((message) => (message as { request_id: string }).request_id),
  ).toEqual(["rejected-match"]);
});
