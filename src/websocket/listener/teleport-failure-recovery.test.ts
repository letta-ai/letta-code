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
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { setActiveRuntime } from "./runtime";
import {
  claimPendingTeleportAtBoundary,
  finalizeClaimedTeleport,
  handleTeleportRequest,
} from "./teleport";
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
  expect(listener.pendingTeleports?.has("teleport-1")).toBe(false);
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
