import { afterEach, expect, mock, test } from "bun:test";
import WebSocket from "ws";
import { settingsManager } from "@/settings-manager";
import { TestDirectory } from "@/test-utils/test-fs";
import {
  getStoredClientPreferences,
  replaceClientPreferences,
} from "@/tools/client-preferences";
import type { TeleportContinuation } from "@/types/protocol_v2";
import {
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
  clearAcceptedFailedTeleport,
  finalizeClaimedTeleport,
  finishClaimedTeleport,
  handleTeleportRequest,
} from "./teleport";
import { finishListenerTurn } from "./turn-terminal";
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

function makeOptions(): StartListenerOptions {
  return {
    connectionId: "source",
    wsUrl: "ws://app-server.test",
    deviceId: "source-device",
    connectionName: "Source",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

function prepareSourceTeleport(
  listener: ListenerRuntime,
  runtime: ConversationRuntime,
  socket: MockSocket,
  continuation?: TeleportContinuation,
): void {
  openListenerConnection({
    runtime: listener,
    connectionId: "source",
    writer: socket as never,
    options: makeOptions(),
  });
  subscribeListenerConnection(listener, "source", {
    agent_id: "agent-1",
    conversation_id: "conversation-1",
  });
  markListenerConnectionInitialized(listener, "source");
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  handleTeleportRequest({
    listener,
    connectionId: "source",
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
  finalizeClaimedTeleport(listener, pending, () =>
    runtime.turnLifecycle.finish(lease, "cancelled"),
  );
}

async function deliverTeleportFailure(params: {
  listener: ListenerRuntime;
  runtime: ConversationRuntime;
  socket: MockSocket;
  processIncomingMessage: (incoming: IncomingMessage) => Promise<void>;
  error: string;
}): Promise<void> {
  let detachedTask: Promise<void> | undefined;
  const handleMessage = createListenerMessageHandler({
    runtime: params.listener,
    socket: params.socket as unknown as WebSocket,
    opts: makeOptions(),
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
    processIncomingMessage: params.processIncomingMessage,
  });

  await handleMessage(
    Buffer.from(
      JSON.stringify({
        type: "teleport_failed",
        teleport_id: "teleport-1",
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conversation-1",
        },
        error: params.error,
      }),
    ),
  );
  await detachedTask;
}

afterEach(() => {
  setActiveRuntime(null);
});

test("active and drained teleport intent is journaled before terminal commit", () => {
  const oldHome = process.env.HOME;
  try {
    for (const activeTurn of [true, false]) {
      const directory = new TestDirectory();
      process.env.HOME = directory.path;
      try {
        const listener = createRuntime();
        listener.connectionId = `conn-${activeTurn ? "active" : "drained"}`;
        listener.connectionGeneration = "generation-original";
        const runtime = getOrCreateScopedRuntime(
          listener,
          "agent-1",
          "conversation-1",
        );
        runtime.turnLifecycle.begin({
          origin: "message",
          workingDirectory: process.cwd(),
        });
        const socket = new MockSocket();
        openListenerConnection({
          runtime: listener,
          connectionId: "source",
          writer: socket as never,
          options: makeOptions(),
        });
        subscribeListenerConnection(listener, "source", {
          agent_id: "agent-1",
          conversation_id: "conversation-1",
        });
        markListenerConnectionInitialized(listener, "source");
        handleTeleportRequest({
          listener,
          connectionId: "source",
          command: {
            type: "teleport_request",
            request_id: `teleport-${activeTurn}`,
            teleport_id: `teleport-${activeTurn}`,
            runtime: {
              agent_id: "agent-1",
              conversation_id: "conversation-1",
            },
            target: {
              connection_id: "target",
              device_id: "target-device",
              connection_name: "Target",
            },
          },
        });
        const continuation = activeTurn
          ? ({
              approvals: [{ tool_call_id: "call-1", approve: true }],
            } as never)
          : undefined;
        const pending = claimPendingTeleportAtBoundary({
          listener,
          agentId: "agent-1",
          conversationId: "conversation-1",
          activeTurn,
          continuation,
        });
        if (!pending) throw new Error("expected pending teleport");

        finishClaimedTeleport(
          runtime,
          pending,
          () => {
            const beforeCommit = createInterruptedTurnStore().read(
              "agent-1",
              "conversation-1",
            );
            expect(beforeCommit?.teleport).toMatchObject({
              teleportId: `teleport-${activeTurn}`,
              activeTurn,
              ...(continuation ? { continuation } : {}),
              ready: false,
            });
            return { finished: true } as never;
          },
          { stopReason: activeTurn ? "cancelled" : "end_turn" },
        );
        expect(
          createInterruptedTurnStore().read("agent-1", "conversation-1")
            ?.teleport,
        ).toMatchObject({ ready: true });

        const restarted = createRuntime();
        restarted.connectionId = "conn-restarted";
        restarted.connectionGeneration = "generation-restarted";
        const restartedSocket = new MockSocket();
        openListenerConnection({
          runtime: restarted,
          connectionId: "source-restarted",
          writer: restartedSocket as never,
          options: { ...makeOptions(), connectionId: "source-restarted" },
        });
        subscribeListenerConnection(restarted, "source-restarted", {
          agent_id: "agent-1",
          conversation_id: "conversation-1",
        });
        markListenerConnectionInitialized(restarted, "source-restarted");
        handleTeleportRequest({
          listener: restarted,
          connectionId: "source-restarted",
          command: {
            type: "teleport_request",
            request_id: `teleport-retry-${activeTurn}`,
            teleport_id: `teleport-${activeTurn}`,
            runtime: {
              agent_id: "agent-1",
              conversation_id: "conversation-1",
            },
            target: {
              connection_id: "target",
              device_id: "target-device",
              connection_name: "Target",
            },
          },
        });
        expect(restartedSocket.sent).toContainEqual(
          expect.objectContaining({
            type: "teleport_ready",
            teleport_id: `teleport-${activeTurn}`,
            active_turn: activeTurn,
            ...(continuation ? { continuation } : {}),
          }),
        );
      } finally {
        createInterruptedTurnStore().remove("agent-1", "conversation-1");
        directory.cleanup();
      }
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("post-terminal authority loss retains proof for same-generation readiness retry", () => {
  const oldHome = process.env.HOME;
  const directory = new TestDirectory();
  process.env.HOME = directory.path;
  try {
    const listener = createRuntime();
    listener.connectionId = "conn-original";
    listener.connectionGeneration = "generation-original";
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conversation-1",
    );
    const socket = new MockSocket();
    openListenerConnection({
      runtime: listener,
      connectionId: "source",
      writer: socket as never,
      options: makeOptions(),
    });
    subscribeListenerConnection(listener, "source", {
      agent_id: "agent-1",
      conversation_id: "conversation-1",
    });
    markListenerConnectionInitialized(listener, "source");
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    handleTeleportRequest({
      listener,
      connectionId: "source",
      command: {
        type: "teleport_request",
        request_id: "teleport-crash",
        teleport_id: "teleport-crash",
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
    if (!pending) throw new Error("expected pending teleport");
    socket.sent.length = 0;

    finishClaimedTeleport(
      runtime,
      pending,
      (options) =>
        finishListenerTurn(runtime, lease, {
          ...options,
          socket: socket as never,
          turnId: "turn-teleport-crash",
          canCommit: () => true,
        }),
      { canCommit: () => false },
    );
    expect(
      createInterruptedTurnStore().read("agent-1", "conversation-1")?.teleport,
    ).toMatchObject({ teleportId: "teleport-crash", ready: false });
    expect(
      socket.sent.some(
        (frame) => (frame as { type?: string }).type === "teleport_ready",
      ),
    ).toBe(false);
    expect(listener.pendingTeleports?.size).toBe(1);

    handleTeleportRequest({
      listener,
      connectionId: "source",
      command: {
        type: "teleport_request",
        request_id: "teleport-crash-retry",
        teleport_id: "teleport-crash",
        runtime: { agent_id: "agent-1", conversation_id: "conversation-1" },
        target: {
          connection_id: "target",
          device_id: "target-device",
          connection_name: "Target",
        },
      },
    });
    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        type: "teleport_ready",
        teleport_id: "teleport-crash",
      }),
    );
    expect(
      createInterruptedTurnStore().read("agent-1", "conversation-1")?.teleport,
    ).toMatchObject({ ready: true });
  } finally {
    createInterruptedTurnStore().remove("agent-1", "conversation-1");
    directory.cleanup();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("idle teleport persistence failures release claims and retries converge", () => {
  const oldHome = process.env.HOME;
  const directory = new TestDirectory();
  process.env.HOME = directory.path;
  const store = createInterruptedTurnStore();
  store.remove("agent-idle", "conversation-idle");
  try {
    const listener = createRuntime();
    listener.connectionId = "conn-idle";
    listener.connectionGeneration = "generation-idle";
    const socket = new MockSocket();
    openListenerConnection({
      runtime: listener,
      connectionId: "source",
      writer: socket as never,
      options: makeOptions(),
    });
    const command = (teleportId: string) => ({
      type: "teleport_request" as const,
      request_id: `${teleportId}-request`,
      teleport_id: teleportId,
      runtime: { agent_id: "agent-idle", conversation_id: "conversation-idle" },
      target: {
        connection_id: "target",
        device_id: "target-device",
        connection_name: "Target",
      },
    });

    handleTeleportRequest({
      listener,
      connectionId: "source",
      command: command("teleport-throw"),
      journalIntent: () => {
        throw new Error("injected journal failure");
      },
    });
    expect(listener.pendingTeleports?.size).toBe(0);
    expect(store.read("agent-idle", "conversation-idle")).toBeNull();

    handleTeleportRequest({
      listener,
      connectionId: "source",
      command: command("teleport-cas"),
      persistIdleReady: () => false,
    });
    expect(listener.pendingTeleports?.size).toBe(0);
    expect(
      store.read("agent-idle", "conversation-idle")?.teleport,
    ).toBeUndefined();

    handleTeleportRequest({
      listener,
      connectionId: "source",
      command: command("teleport-cas"),
    });
    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        type: "teleport_ready",
        teleport_id: "teleport-cas",
      }),
    );
    expect(
      store.read("agent-idle", "conversation-idle")?.teleport,
    ).toMatchObject({
      teleportId: "teleport-cas",
      ready: true,
    });
  } finally {
    store.remove("agent-idle", "conversation-idle");
    directory.cleanup();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("idle teleport survives restart, rejects a different id, and admits failure once", async () => {
  const oldHome = process.env.HOME;
  const directory = new TestDirectory();
  process.env.HOME = directory.path;
  const store = createInterruptedTurnStore();
  store.remove("agent-1", "conversation-1");
  try {
    const original = createRuntime();
    original.connectionId = "conn-original-idle";
    original.connectionGeneration = "generation-original-idle";
    const originalSocket = new MockSocket();
    openListenerConnection({
      runtime: original,
      connectionId: "source",
      writer: originalSocket as never,
      options: makeOptions(),
    });
    handleTeleportRequest({
      listener: original,
      connectionId: "source",
      command: {
        type: "teleport_request",
        request_id: "teleport-1-request",
        teleport_id: "teleport-1",
        runtime: { agent_id: "agent-1", conversation_id: "conversation-1" },
        target: {
          connection_id: "target",
          device_id: "target-device",
          connection_name: "Target",
        },
      },
    });
    expect(store.read("agent-1", "conversation-1")?.teleport).toMatchObject({
      teleportId: "teleport-1",
      ready: true,
    });

    const restarted = createRuntime();
    restarted.connectionId = "conn-restarted-idle";
    restarted.connectionGeneration = "generation-restarted-idle";
    const restartedRuntime = getOrCreateScopedRuntime(
      restarted,
      "agent-1",
      "conversation-1",
    );
    const restartedSocket = new MockSocket();
    openListenerConnection({
      runtime: restarted,
      connectionId: "source",
      writer: restartedSocket as never,
      options: makeOptions(),
    });
    subscribeListenerConnection(restarted, "source", {
      agent_id: "agent-1",
      conversation_id: "conversation-1",
    });
    markListenerConnectionInitialized(restarted, "source");
    handleTeleportRequest({
      listener: restarted,
      connectionId: "source",
      command: {
        type: "teleport_request",
        request_id: "teleport-other-request",
        teleport_id: "teleport-other",
        runtime: { agent_id: "agent-1", conversation_id: "conversation-1" },
        target: {
          connection_id: "target",
          device_id: "target-device",
          connection_name: "Target",
        },
      },
    });
    expect(restartedSocket.sent).toContainEqual(
      expect.objectContaining({
        teleport_id: "teleport-other",
        success: false,
        error: "Conversation already has a teleport pending",
      }),
    );

    const received: IncomingMessage[] = [];
    const processIncomingMessage = mock(async (incoming: IncomingMessage) => {
      received.push(incoming);
    });
    setActiveRuntime(restarted);
    await deliverTeleportFailure({
      listener: restarted,
      runtime: restartedRuntime,
      socket: restartedSocket,
      processIncomingMessage,
      error: "Destination crashed",
    });
    await deliverTeleportFailure({
      listener: restarted,
      runtime: restartedRuntime,
      socket: restartedSocket,
      processIncomingMessage,
      error: "Destination crashed",
    });
    expect(processIncomingMessage).toHaveBeenCalledTimes(1);
    expect(received[0]?.durableInputIdentities).toEqual([
      { domain: "teleport", id: "teleport-1" },
    ]);
    expect(store.read("agent-1", "conversation-1")?.teleport).toBeUndefined();
  } finally {
    setActiveRuntime(null);
    store.remove("agent-1", "conversation-1");
    directory.cleanup();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("failed teleport cleanup retries beyond three conflicts without overwriting a successor", async () => {
  const listener = createRuntime();
  const pending = {
    teleportId: "teleport-a",
    connectionId: "source",
    agentId: "agent-cleanup",
    conversationId: "conversation-cleanup",
    requestedAt: Date.now(),
    drainAcceptedInputs: false,
    activeTurn: false,
  };
  let writes = 0;
  const record = {
    revision: "revision-a",
    agentId: pending.agentId,
    conversationId: pending.conversationId,
    runId: null,
    toolCallIds: [],
    results: [],
    requestOtid: "request-a",
    workingDirectory: "/project",
    teleport: {
      teleportId: pending.teleportId,
      connectionId: pending.connectionId,
      activeTurn: false,
      ready: true,
    },
  };
  const store = {
    read: () => record,
    write: () => {
      writes += 1;
      if (writes <= 4) throw new Error("injected CAS conflict");
      return { ...record, revision: "revision-cleared", teleport: undefined };
    },
  } as never;
  clearAcceptedFailedTeleport(listener, pending, { store, retryDelayMs: 1 });
  const deadline = performance.now() + 2_000;
  while (writes < 5 && performance.now() < deadline) await Bun.sleep(5);
  expect(writes).toBe(5);

  let successorWrites = 0;
  const successorStore = {
    read: () => ({
      ...record,
      revision: "revision-b",
      teleport: { ...record.teleport, teleportId: "teleport-b" },
    }),
    write: () => {
      successorWrites += 1;
      return record;
    },
  } as never;
  clearAcceptedFailedTeleport(listener, pending, {
    store: successorStore,
    retryDelayMs: 1,
  });
  expect(successorWrites).toBe(0);
  listener.intentionallyClosed = true;
});

test("same teleport id is isolated by runtime and retries rebind to the requester", () => {
  const listener = createRuntime();
  const socketA = new MockSocket();
  const socketB = new MockSocket();
  for (const [connectionId, socket] of [
    ["source-a", socketA],
    ["source-b", socketB],
  ] as const) {
    openListenerConnection({
      runtime: listener,
      connectionId,
      writer: socket as never,
      options: { ...makeOptions(), connectionId },
    });
    markListenerConnectionInitialized(listener, connectionId);
  }
  const request = (conversationId: string, connectionId: string): void =>
    handleTeleportRequest({
      listener,
      connectionId,
      command: {
        type: "teleport_request",
        request_id: `${conversationId}-${connectionId}`,
        teleport_id: "shared-id",
        runtime: { agent_id: "agent-1", conversation_id: conversationId },
        target: {
          connection_id: "target",
          device_id: "target-device",
          connection_name: "Target",
        },
      },
    });

  request("conversation-1", "source-a");
  request("conversation-2", "source-b");
  expect(listener.pendingTeleports?.size).toBe(2);
  expect(socketA.sent).toContainEqual(
    expect.objectContaining({
      teleport_id: "shared-id",
      runtime: expect.objectContaining({ conversation_id: "conversation-1" }),
    }),
  );
  expect(socketB.sent).toContainEqual(
    expect.objectContaining({
      teleport_id: "shared-id",
      runtime: expect.objectContaining({ conversation_id: "conversation-2" }),
    }),
  );

  socketB.sent.length = 0;
  request("conversation-1", "source-b");
  expect(socketB.sent).toContainEqual(
    expect.objectContaining({
      teleport_id: "shared-id",
      runtime: expect.objectContaining({ conversation_id: "conversation-1" }),
    }),
  );
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

test("terminal teleport failure resumes the source without approvals", async () => {
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
  expect(listener.pendingTeleports?.size).toBe(0);
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

test("teleport readiness is fenced by durable source terminal commit", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  const socket = new MockSocket();
  openListenerConnection({
    runtime: listener,
    connectionId: "source",
    writer: socket as never,
    options: makeOptions(),
  });
  subscribeListenerConnection(listener, "source", {
    agent_id: "agent-1",
    conversation_id: "conversation-1",
  });
  markListenerConnectionInitialized(listener, "source");
  handleTeleportRequest({
    listener,
    connectionId: "source",
    command: {
      type: "teleport_request",
      request_id: "teleport-gated",
      teleport_id: "teleport-gated",
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
    conversationId: runtime.conversationId,
    activeTurn: true,
  });
  if (!pending) throw new Error("expected claimed teleport");
  socket.sent.length = 0;

  expect(
    finalizeClaimedTeleport(listener, pending, () => ({ finished: false })),
  ).toEqual({ finished: false });
  expect(socket.sent).toEqual([]);
  expect(pending.readyAt).toBeUndefined();
  expect(
    finalizeClaimedTeleport(
      listener,
      pending,
      () => ({ finished: true }),
      () => false,
    ),
  ).toEqual({ finished: true });
  expect(socket.sent).toEqual([]);
  expect(pending.readyAt).toBeUndefined();
  expect(
    finalizeClaimedTeleport(listener, pending, () => ({ finished: true })),
  ).toEqual({ finished: true });
  expect(socket.sent).toContainEqual(
    expect.objectContaining({
      type: "teleport_ready",
      teleport_id: "teleport-gated",
    }),
  );
});
