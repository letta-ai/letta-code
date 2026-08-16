import { afterEach, expect, mock, test } from "bun:test";
import WebSocket from "ws";
import { openListenerConnection } from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { dispatchInboundMessageWhenReady } from "./inbound-dispatch";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { setActiveRuntime } from "./runtime";
import {
  claimPendingTeleportAtBoundary,
  finishPendingTeleport,
  finishTeleport,
  handleTeleportRequest,
  isRuntimeTeleportPending,
} from "./teleport";
import type { IncomingMessage, StartListenerOptions } from "./types";

class MockSocket {
  readonly bufferedAmount = 0;
  readyState: number = WebSocket.OPEN;
  readonly sent: unknown[] = [];

  isOpen(): boolean {
    return this.readyState === WebSocket.OPEN;
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

function openSource(
  listener: ReturnType<typeof createRuntime>,
  socket: MockSocket,
): void {
  openListenerConnection({
    runtime: listener,
    connectionId: "source",
    writer: socket as never,
    options: makeOptions(),
  });
}

function requestTeleport(listener: ReturnType<typeof createRuntime>): void {
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
}

function inputFrame(requestId: string, clientMessageId: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: "input",
      request_id: requestId,
      runtime: { agent_id: "agent-1", conversation_id: "conversation-1" },
      payload: {
        kind: "create_message",
        messages: [
          {
            role: "user",
            content: requestId,
            client_message_id: clientMessageId,
          },
        ],
      },
    }),
  );
}

afterEach(() => {
  setActiveRuntime(null);
});

test("new production input waits outside a pending teleport", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const socket = new MockSocket();
  const sent: unknown[] = [];
  const processIncomingMessage = mock(async () => {});
  openSource(listener, socket);
  setActiveRuntime(listener);
  requestTeleport(listener);
  runtime.acceptedInputDispositions.set("cm-known", "queued");
  const handleMessage = createListenerMessageHandler({
    runtime: listener,
    socket: socket as unknown as WebSocket,
    opts: makeOptions(),
    processQueuedTurn: async () => {},
    fileCommandSession: { handle: () => false },
    getParsedRuntimeScope: () => null,
    replaySyncStateForRuntime: async () => {},
    getOrCreateScopedRuntime: () => runtime,
    handleApprovalResponseInput: async () => false,
    handleChangeDeviceStateInput: async () => false,
    handleAbortMessageInput: async () => false,
    stampInboundUserMessageOtids: (incoming) => incoming,
    safeSocketSend: (_target, payload) => {
      sent.push(payload);
      return true;
    },
    runDetachedListenerTask: () => {},
    trackListenerError: () => {},
    processIncomingMessage,
  });

  await handleMessage(inputFrame("known-retry", "cm-known"));
  await handleMessage(inputFrame("new-during-switch", "cm-new"));

  expect(sent).toContainEqual(
    expect.objectContaining({
      type: "input_accepted",
      request_id: "known-retry",
      accepted: true,
      disposition: "queued",
    }),
  );
  expect(sent).toContainEqual(
    expect.objectContaining({
      type: "input_accepted",
      request_id: "new-during-switch",
      accepted: false,
    }),
  );
  expect(runtime.queueRuntime.length).toBe(0);
  expect(processIncomingMessage).not.toHaveBeenCalled();
});

test("serialized direct input cannot start after source readiness", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const socket = new MockSocket();
  openSource(listener, socket);
  setActiveRuntime(listener);
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  let releaseCurrentTurn: (() => void) | undefined;
  runtime.messageQueue = new Promise<void>((resolve) => {
    releaseCurrentTurn = resolve;
  });
  const processIncomingMessage = mock(async () => {});
  const onInputAccepted = mock(() => {});

  dispatchInboundMessageWhenReady({
    listener,
    runtime,
    incoming: {
      type: "message",
      connectionId: "source",
      agentId: "agent-1",
      conversationId: "conversation-1",
      messages: [{ role: "user", content: "follow up" }],
    },
    socket: socket as never,
    options: makeOptions(),
    processQueuedTurn: mock(async () => {}),
    processIncomingMessage,
    trackListenerError: mock(() => {}),
    onInputAccepted,
  });

  requestTeleport(listener);
  const pending = claimPendingTeleportAtBoundary({
    listener,
    agentId: "agent-1",
    conversationId: "conversation-1",
    activeTurn: true,
  });
  expect(pending).not.toBeNull();
  if (!pending) throw new Error("Teleport did not reach the source boundary");
  finishTeleport(runtime, lease, pending);
  releaseCurrentTurn?.();
  await runtime.messageQueue;

  expect(onInputAccepted).toHaveBeenCalledWith({ accepted: false });
  expect(processIncomingMessage).not.toHaveBeenCalled();
});

test("accepted queue drains before teleport readiness", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const socket = new MockSocket();
  openSource(listener, socket);
  const firstLease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  runtime.queueRuntime.enqueue({
    kind: "message",
    source: "user",
    content: "already accepted",
    clientMessageId: "cm-accepted",
    agentId: "agent-1",
    conversationId: "conversation-1",
  } as Parameters<typeof runtime.queueRuntime.enqueue>[0]);

  requestTeleport(listener);
  const pending = listener.pendingTeleports?.get("teleport-1");
  expect(pending?.drainAcceptedInputs).toBe(true);
  expect(
    claimPendingTeleportAtBoundary({
      listener,
      agentId: "agent-1",
      conversationId: "conversation-1",
      activeTurn: true,
    }),
  ).toBeNull();
  runtime.turnLifecycle.finish(firstLease, "end_turn");
  finishPendingTeleport(runtime);
  expect(pending?.readyAt).toBeUndefined();

  runtime.queueRuntime.consumeItems(1);
  const queuedLease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  expect(
    claimPendingTeleportAtBoundary({
      listener,
      agentId: "agent-1",
      conversationId: "conversation-1",
      activeTurn: true,
    }),
  ).toBeNull();
  runtime.turnLifecycle.finish(queuedLease, "error");
  finishPendingTeleport(runtime);

  expect(pending?.readyAt).toEqual(expect.any(Number));
  expect(pending?.activeTurn).toBe(false);
  expect(socket.sent).toContainEqual(
    expect.objectContaining({
      type: "teleport_ready",
      teleport_id: "teleport-1",
      active_turn: false,
      success: true,
    }),
  );
});

test("reverse teleport clears the returning destination's old marker", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const socket = new MockSocket();
  const sent: unknown[] = [];
  openSource(listener, socket);
  setActiveRuntime(listener);
  listener.pendingTeleports = new Map([
    [
      "teleport-outbound",
      {
        teleportId: "teleport-outbound",
        connectionId: "source",
        agentId: "agent-1",
        conversationId: "conversation-1",
        requestedAt: 1,
        drainAcceptedInputs: false,
        activeTurn: true,
        readyAt: 2,
      },
    ],
  ]);
  const handleMessage = createListenerMessageHandler({
    runtime: listener,
    socket: socket as unknown as WebSocket,
    opts: makeOptions(),
    processQueuedTurn: async () => {},
    fileCommandSession: { handle: () => false },
    getParsedRuntimeScope: () => null,
    replaySyncStateForRuntime: async () => {},
    getOrCreateScopedRuntime: () => runtime,
    handleApprovalResponseInput: async () => false,
    handleChangeDeviceStateInput: async () => false,
    handleAbortMessageInput: async () => false,
    stampInboundUserMessageOtids: (incoming) => incoming,
    safeSocketSend: (_target, payload) => {
      sent.push(payload);
      return true;
    },
    runDetachedListenerTask: () => {},
    trackListenerError: () => {},
    processIncomingMessage: async (_incoming: IncomingMessage) => {},
  });

  await handleMessage(
    Buffer.from(
      JSON.stringify({
        type: "input",
        request_id: "reverse-continue",
        runtime: { agent_id: "agent-1", conversation_id: "conversation-1" },
        payload: {
          kind: "teleport_continue",
          teleport_id: "teleport-return",
          source: { device_id: "away", connection_name: "Away" },
        },
      }),
    ),
  );

  expect(isRuntimeTeleportPending(listener, "agent-1", "conversation-1")).toBe(
    false,
  );
  expect(sent).toContainEqual(
    expect.objectContaining({
      type: "input_accepted",
      request_id: "reverse-continue",
      accepted: true,
    }),
  );
});
