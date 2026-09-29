import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local";
import {
  getOrCreateProcessTransport,
  getSubscribedListenerConnections,
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
  suspendListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { dispatchInboundMessageWhenReady } from "./inbound-dispatch";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime, startConnectedListenerRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { scheduleQueuePump } from "./queue";
import { setActiveRuntime } from "./runtime";
import { isListenerTransportOpen, LocalListenerTransport } from "./transport";
import type { IncomingMessage, StartListenerOptions } from "./types";

class MockSocket {
  readyState: number = WebSocket.OPEN;
  sentPayloads: string[] = [];

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }
}

function makeListenerOptions(): StartListenerOptions {
  return {
    connectionId: "conn-boundary-test",
    wsUrl: "wss://example.test/ws",
    deviceId: "device-boundary-test",
    connectionName: "listener-boundary-test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

function queuedMessage(clientMessageId: string) {
  return {
    type: "message" as const,
    agentId: "agent-1",
    conversationId: "conv-1",
    messages: [
      {
        role: "user" as const,
        content: clientMessageId,
        client_message_id: clientMessageId,
      },
    ],
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for listener state");
}

afterEach(() => {
  setActiveRuntime(null);
});

test("a queued input drains once after its scheduled socket is replaced", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const options = makeListenerOptions();
  const oldSocket = new MockSocket();
  const newSocket = new MockSocket();
  const oldTransport = oldSocket as unknown as WebSocket;
  const newTransport = newSocket as unknown as WebSocket;
  setActiveRuntime(listener);
  openListenerConnection({
    runtime: listener,
    connectionId: options.connectionId,
    writer: oldTransport,
    options,
  });
  markListenerConnectionInitialized(listener, options.connectionId);
  subscribeListenerConnection(listener, options.connectionId, {
    agent_id: "agent-1",
    conversation_id: "conv-1",
  });

  // An active direct turn owns messageQueue. The input is accepted and the
  // pump is scheduled behind that turn, while its socket is still open.
  let finishDirectTurn!: () => void;
  runtime.messageQueue = new Promise<void>((resolve) => {
    finishDirectTurn = resolve;
  });
  expect(
    enqueueInboundUserMessage(runtime, {
      ...queuedMessage("cm-reconnect"),
      connectionId: options.connectionId,
    }),
  ).toBe(true);
  const processed: string[] = [];
  const processQueuedTurn = async () => {
    processed.push("cm-reconnect");
  };
  scheduleQueuePump(runtime, oldTransport, options, processQueuedTurn);

  // Reconnect recovery observes the queued item and requests a pump with the
  // stable process transport, but the old scheduled pump already owns the slot.
  oldSocket.readyState = WebSocket.CLOSED;
  suspendListenerConnection(listener, options.connectionId);
  openListenerConnection({
    runtime: listener,
    connectionId: options.connectionId,
    writer: newTransport,
    options,
  });
  markListenerConnectionInitialized(listener, options.connectionId);
  scheduleQueuePump(
    runtime,
    getOrCreateProcessTransport(listener),
    options,
    processQueuedTurn,
  );
  // Direct-turn cleanup may also request the old socket before it settles.
  scheduleQueuePump(runtime, oldTransport, options, processQueuedTurn);
  finishDirectTurn();
  await runtime.messageQueue;

  expect(processed).toEqual(["cm-reconnect"]);
  expect(runtime.queueRuntime.length).toBe(0);
  expect(runtime.queuedMessagesByItemId.size).toBe(0);
  expect(oldSocket.sentPayloads).toEqual([]);
  expect(newSocket.sentPayloads.length).toBeGreaterThan(0);
});

test("a suspended connection drops queued request-scoped context", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const options = makeListenerOptions();
  const oldSocket = new MockSocket();
  const newSocket = new MockSocket();
  setActiveRuntime(listener);
  openListenerConnection({
    runtime: listener,
    connectionId: options.connectionId,
    writer: oldSocket as unknown as WebSocket,
    options,
  });
  markListenerConnectionInitialized(listener, options.connectionId);
  subscribeListenerConnection(listener, options.connectionId, {
    agent_id: "agent-1",
    conversation_id: "conv-1",
  });

  expect(
    enqueueInboundUserMessage(runtime, {
      ...queuedMessage("cm-scoped-reconnect"),
      connectionId: options.connectionId,
      requestScopedClientSkills: [
        {
          name: "browser-control-session",
          description: "ephemeral",
          location: "request://browser-control-session",
        },
      ],
      requestScopedSecretEnv: { BROWSER_CONTROL_KEY: "secret" },
    }),
  ).toBe(true);
  runtime.acceptedInputDispositions.set("cm-scoped-reconnect", "queued");

  oldSocket.readyState = WebSocket.CLOSED;
  suspendListenerConnection(listener, options.connectionId);

  expect(runtime.queueRuntime.length).toBe(0);
  expect(runtime.queuedMessagesByItemId.size).toBe(0);
  expect(runtime.acceptedInputDispositions.has("cm-scoped-reconnect")).toBe(
    false,
  );

  openListenerConnection({
    runtime: listener,
    connectionId: options.connectionId,
    writer: newSocket as unknown as WebSocket,
    options,
  });
  markListenerConnectionInitialized(listener, options.connectionId);
  const processed: string[] = [];
  scheduleQueuePump(
    runtime,
    getOrCreateProcessTransport(listener),
    options,
    async () => {
      processed.push("cm-scoped-reconnect");
    },
  );
  await runtime.messageQueue;

  expect(processed).toEqual([]);
  expect(
    enqueueInboundUserMessage(runtime, {
      ...queuedMessage("cm-scoped-reconnect"),
      connectionId: options.connectionId,
      requestScopedSecretEnv: { BROWSER_CONTROL_KEY: "fresh-secret" },
    }),
  ).toBe(true);
});

test("suspension drops request-scoped input still waiting on messageQueue", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const options = makeListenerOptions();
  const oldSocket = new MockSocket();
  const newSocket = new MockSocket();
  setActiveRuntime(listener);
  openListenerConnection({
    runtime: listener,
    connectionId: options.connectionId,
    writer: oldSocket as unknown as WebSocket,
    options,
  });

  let releaseMessageQueue!: () => void;
  runtime.messageQueue = new Promise<void>((resolve) => {
    releaseMessageQueue = resolve;
  });
  const processed: string[] = [];
  const acknowledgements: boolean[] = [];
  dispatchInboundMessageWhenReady({
    listener,
    runtime,
    incoming: {
      ...queuedMessage("cm-scoped-pending-suspend"),
      connectionId: options.connectionId,
      noCoalesce: true,
      requestScopedSecretEnv: { BROWSER_CONTROL_KEY: "stale-secret" },
    },
    socket: oldSocket as unknown as WebSocket,
    options,
    processQueuedTurn: async () => {},
    processIncomingMessage: async () => {
      processed.push("cm-scoped-pending-suspend");
    },
    trackListenerError: () => {},
    onInputAccepted: ({ accepted }) => acknowledgements.push(accepted),
  });

  oldSocket.readyState = WebSocket.CLOSED;
  suspendListenerConnection(listener, options.connectionId);
  openListenerConnection({
    runtime: listener,
    connectionId: options.connectionId,
    writer: newSocket as unknown as WebSocket,
    options,
  });
  releaseMessageQueue();
  await runtime.messageQueue;

  expect(processed).toEqual([]);
  expect(acknowledgements).toEqual([false]);
  expect(runtime.queueRuntime.length).toBe(0);
  expect(runtime.queuedMessagesByItemId.size).toBe(0);
});

test("queue clear drops request-scoped input still waiting on messageQueue", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const options = makeListenerOptions();
  const socket = new MockSocket();
  setActiveRuntime(listener);
  openListenerConnection({
    runtime: listener,
    connectionId: options.connectionId,
    writer: socket as unknown as WebSocket,
    options,
  });

  let releaseMessageQueue!: () => void;
  runtime.messageQueue = new Promise<void>((resolve) => {
    releaseMessageQueue = resolve;
  });
  const processed: string[] = [];
  const acknowledgements: boolean[] = [];
  dispatchInboundMessageWhenReady({
    listener,
    runtime,
    incoming: {
      ...queuedMessage("cm-scoped-pending-clear"),
      connectionId: options.connectionId,
      noCoalesce: true,
      requestScopedSecretEnv: { BROWSER_CONTROL_KEY: "stale-secret" },
    },
    socket: socket as unknown as WebSocket,
    options,
    processQueuedTurn: async () => {},
    processIncomingMessage: async () => {
      processed.push("cm-scoped-pending-clear");
    },
    trackListenerError: () => {},
    onInputAccepted: ({ accepted }) => acknowledgements.push(accepted),
  });

  runtime.queueRuntime.clear("cancelled");
  releaseMessageQueue();
  await runtime.messageQueue;

  expect(processed).toEqual([]);
  expect(acknowledgements).toEqual([false]);
  expect(runtime.queueRuntime.length).toBe(0);
  expect(runtime.queuedMessagesByItemId.size).toBe(0);
});

test("clearing a conversation queue also clears retained payloads", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  expect(
    enqueueInboundUserMessage(runtime, {
      ...queuedMessage("cm-cleared"),
      connectionId: "conn-cleared",
      requestScopedSecretEnv: { BROWSER_CONTROL_KEY: "secret" },
    }),
  ).toBe(true);
  runtime.acceptedInputDispositions.set("cm-cleared", "queued");

  runtime.queueRuntime.clear("cancelled");

  expect(runtime.queueRuntime.length).toBe(0);
  expect(runtime.queuedMessagesByItemId.size).toBe(0);
  expect(runtime.acceptedInputDispositions.has("cm-cleared")).toBe(false);
});

test("an unrelated connection cannot drain a disconnected conversation", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const optionsA = makeListenerOptions();
  const optionsB = { ...makeListenerOptions(), connectionId: "conn-b" };
  const oldA = new MockSocket();
  const newA = new MockSocket();
  const socketB = new MockSocket();
  setActiveRuntime(listener);
  openListenerConnection({
    runtime: listener,
    connectionId: optionsA.connectionId,
    writer: oldA as unknown as WebSocket,
    options: optionsA,
  });
  markListenerConnectionInitialized(listener, optionsA.connectionId);
  subscribeListenerConnection(listener, optionsA.connectionId, {
    agent_id: "agent-1",
    conversation_id: "conv-1",
  });
  expect(enqueueInboundUserMessage(runtime, queuedMessage("only-a"))).toBe(
    true,
  );
  const processed: string[] = [];
  const processQueuedTurn = async () => {
    processed.push("only-a");
  };
  scheduleQueuePump(
    runtime,
    oldA as unknown as WebSocket,
    optionsA,
    processQueuedTurn,
  );

  oldA.readyState = WebSocket.CLOSED;
  suspendListenerConnection(listener, optionsA.connectionId);
  openListenerConnection({
    runtime: listener,
    connectionId: optionsB.connectionId,
    writer: socketB as unknown as WebSocket,
    options: optionsB,
  });
  markListenerConnectionInitialized(listener, optionsB.connectionId);
  subscribeListenerConnection(listener, optionsB.connectionId, {
    agent_id: "agent-2",
    conversation_id: "conv-2",
  });
  const processTransport = getOrCreateProcessTransport(listener);
  expect(isListenerTransportOpen(processTransport)).toBe(true);
  // Reconnect recovery schedules queued scopes even when the new connection
  // belongs to a different conversation.
  scheduleQueuePump(runtime, processTransport, optionsB, processQueuedTurn);
  await runtime.messageQueue;
  expect(processed).toEqual([]);
  expect(runtime.queueRuntime.length).toBe(1);
  expect(runtime.queuedMessagesByItemId.size).toBe(1);
  expect(socketB.sentPayloads).toEqual([]);

  openListenerConnection({
    runtime: listener,
    connectionId: optionsA.connectionId,
    writer: newA as unknown as WebSocket,
    options: optionsA,
  });
  markListenerConnectionInitialized(listener, optionsA.connectionId);
  scheduleQueuePump(runtime, processTransport, optionsA, processQueuedTurn);
  await runtime.messageQueue;
  expect(processed).toEqual(["only-a"]);
  expect(runtime.queueRuntime.length).toBe(0);
  expect(newA.sentPayloads.length).toBeGreaterThan(0);
  expect(socketB.sentPayloads).toEqual([]);
});

test("a new connection's runtime_start resumes queued work after the startup pump found no subscriber", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "listener-queue-reconnect-"));
  try {
    const backend = new LocalBackend({
      storageDir,
      executionMode: "deterministic",
    });
    __testSetBackend(backend);
    const agent = await backend.createAgent({
      name: "Reconnect",
      model: "anthropic/claude-sonnet-4-6",
    } as AgentCreateBody);
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, agent.id, "default");
    const oldOptions = makeListenerOptions();
    const oldSocket = new MockSocket();
    const nextOptions = { ...oldOptions, connectionId: "new-connection" };
    const nextSocket = new MockSocket();
    const processed: string[] = [];
    let markReplayStarted!: () => void;
    let finishReplay!: () => void;
    const replayStarted = new Promise<void>((resolve) => {
      markReplayStarted = resolve;
    });
    const replayBlocked = new Promise<void>((resolve) => {
      finishReplay = resolve;
    });
    const processQueuedTurn = async (turn: IncomingMessage) => {
      const message = turn.messages[0];
      if (message && "content" in message)
        processed.push(String(message.content));
    };
    setActiveRuntime(listener);
    openListenerConnection({
      runtime: listener,
      connectionId: oldOptions.connectionId,
      writer: oldSocket as unknown as WebSocket,
      options: oldOptions,
    });
    markListenerConnectionInitialized(listener, oldOptions.connectionId);
    subscribeListenerConnection(listener, oldOptions.connectionId, {
      agent_id: agent.id,
      conversation_id: "default",
    });
    runtime.queueRuntime.enqueue({
      kind: "cron_prompt",
      source: "cron",
      text: "queued cron",
      agentId: agent.id,
      conversationId: "default",
    } as Parameters<typeof runtime.queueRuntime.enqueue>[0]);
    oldSocket.readyState = WebSocket.CLOSED;
    suspendListenerConnection(listener, oldOptions.connectionId);
    openListenerConnection({
      runtime: listener,
      connectionId: nextOptions.connectionId,
      writer: nextSocket as unknown as WebSocket,
      options: nextOptions,
    });
    await startConnectedListenerRuntime(
      listener,
      nextSocket as unknown as WebSocket,
      nextOptions,
      processQueuedTurn,
      {
        startHeartbeat: false,
        startCronScheduler: false,
        emitInitialState: false,
      },
    );
    await runtime.messageQueue;
    expect(processed).toEqual([]);
    expect(runtime.queueRuntime.length).toBe(1);
    const tasks: Promise<void>[] = [];
    const responses: unknown[] = [];
    const handleMessage = createListenerMessageHandler({
      runtime: listener,
      socket: nextSocket as unknown as WebSocket,
      opts: nextOptions,
      processQueuedTurn,
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {
        markReplayStarted();
        await replayBlocked;
      },
      getOrCreateScopedRuntime,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend: (_socket, payload) => {
        responses.push(payload);
        return true;
      },
      runDetachedListenerTask: (_name, task) => {
        tasks.push(task());
      },
      trackListenerError: (error) => {
        throw error;
      },
    });
    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "runtime_start",
          request_id: "reconnect",
          agent_id: agent.id,
          conversation_id: "default",
          recover_approvals: false,
          wait_for_replay: true,
        }),
      ),
    );
    await replayStarted;
    await Bun.sleep(0);
    expect(processed).toEqual([]);
    expect(responses).toEqual([]);
    finishReplay();
    await Promise.all(tasks);
    expect(responses).toContainEqual(
      expect.objectContaining({
        type: "runtime_start_response",
        success: true,
      }),
    );
    expect(
      getSubscribedListenerConnections(listener, {
        agent_id: agent.id,
        conversation_id: "default",
      }).map((connection) => connection.id),
    ).toEqual([nextOptions.connectionId]);
    await waitFor(() => processed.length === 1);
    await runtime.messageQueue;
    expect(processed).toEqual(["queued cron"]);
    expect(runtime.queueRuntime.length).toBe(0);
    expect(oldSocket.sentPayloads).toEqual([]);
    expect(nextSocket.sentPayloads.length).toBeGreaterThan(0);
  } finally {
    setActiveRuntime(null);
    __testSetBackend(null);
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("a local listener runs queued work without a remote subscriber", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const options = makeListenerOptions();
  const transport = new LocalListenerTransport();
  setActiveRuntime(listener);
  openListenerConnection({
    runtime: listener,
    connectionId: options.connectionId,
    writer: transport,
    options,
  });
  markListenerConnectionInitialized(listener, options.connectionId);
  expect(enqueueInboundUserMessage(runtime, queuedMessage("local"))).toBe(true);
  const processed: string[] = [];
  scheduleQueuePump(runtime, transport, options, async () => {
    processed.push("local");
  });
  await runtime.messageQueue;
  expect(processed).toEqual(["local"]);
  expect(runtime.queueRuntime.length).toBe(0);
});

test("an active pump switches transport after reconnect without replaying its turn", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const options = makeListenerOptions();
  const oldSocket = new MockSocket();
  const newSocket = new MockSocket();
  const oldTransport = oldSocket as unknown as WebSocket;
  const newTransport = newSocket as unknown as WebSocket;
  setActiveRuntime(listener);
  openListenerConnection({
    runtime: listener,
    connectionId: options.connectionId,
    writer: oldTransport,
    options,
  });
  markListenerConnectionInitialized(listener, options.connectionId);
  subscribeListenerConnection(listener, options.connectionId, {
    agent_id: "agent-1",
    conversation_id: "conv-1",
  });

  let finishFirstTurn!: () => void;
  const firstTurnFinished = new Promise<void>((resolve) => {
    finishFirstTurn = resolve;
  });
  const processed: string[] = [];
  const processQueuedTurn = async (turn: IncomingMessage) => {
    const message = turn.messages[0];
    processed.push(
      message && "content" in message ? String(message.content) : "missing",
    );
    if (processed.length === 1) await firstTurnFinished;
  };
  expect(enqueueInboundUserMessage(runtime, queuedMessage("first"))).toBe(true);
  scheduleQueuePump(runtime, oldTransport, options, processQueuedTurn);
  await waitFor(() => processed.length === 1 && runtime.queuePumpActive);
  expect(enqueueInboundUserMessage(runtime, queuedMessage("second"))).toBe(
    true,
  );
  oldSocket.readyState = WebSocket.CLOSED;
  suspendListenerConnection(listener, options.connectionId);
  openListenerConnection({
    runtime: listener,
    connectionId: options.connectionId,
    writer: newTransport,
    options,
  });
  markListenerConnectionInitialized(listener, options.connectionId);
  subscribeListenerConnection(listener, options.connectionId, {
    agent_id: "agent-1",
    conversation_id: "conv-1",
  });
  scheduleQueuePump(
    runtime,
    getOrCreateProcessTransport(listener),
    options,
    processQueuedTurn,
  );
  finishFirstTurn();
  await waitFor(() => processed.length === 2 && !runtime.queuePumpActive);
  await runtime.messageQueue;

  expect(processed).toEqual(["first", "second"]);
  expect(runtime.queueRuntime.length).toBe(0);
  expect(newSocket.sentPayloads.length).toBeGreaterThan(0);
});

// Queue frames are otherwise emitted only on change and loop frames only on
// transition, so a single lost frame leaves downstream status consumers stale
// until the next change happens to land (LET-11174). These tests pin the
// repair: every turn produces unconditional queue + loop snapshots at turn
// start and turn end, even when nothing about the queue changed in between.
test("a turn emits queue and loop snapshots at both boundaries even when the queue is unchanged", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const socket = new MockSocket();
  listener.socket = socket as unknown as WebSocket;
  setActiveRuntime(listener);

  expect(enqueueInboundUserMessage(runtime, queuedMessage("cm-turn"))).toBe(
    true,
  );

  let turnStartFrameCount = -1;
  let processedTurns = 0;
  scheduleQueuePump(
    runtime,
    socket as unknown as WebSocket,
    makeListenerOptions(),
    async () => {
      // Snapshot what was already emitted when the turn body begins. The
      // queue is unchanged from here to turn end: the end-boundary frames
      // must be new emissions, not leftovers of the dequeue transition.
      turnStartFrameCount = socket.sentPayloads.length;
      processedTurns += 1;
    },
  );
  await waitFor(() => processedTurns === 1 && !runtime.queuePumpActive);
  // The dequeue-transition frame rides a microtask; let it flush so the
  // assertion below counts every frame belonging to this turn.
  await Bun.sleep(5);

  const parsed = socket.sentPayloads.map(
    (payload) => JSON.parse(payload) as Record<string, unknown>,
  );
  const framesBeforeTurnBody = parsed.slice(0, turnStartFrameCount);
  const framesAfterTurnBody = parsed.slice(turnStartFrameCount);

  // Turn start boundary: an unconditional queue snapshot (empty queue, no
  // removal transitions — distinct from the dequeue-transition frame) and a
  // loop status frame were emitted before the turn body ran.
  expect(
    framesBeforeTurnBody.some(
      (frame) =>
        frame.type === "update_queue" &&
        Array.isArray(frame.queue) &&
        frame.queue.length === 0 &&
        Array.isArray(frame.removed) &&
        frame.removed.length === 0,
    ),
  ).toBe(true);
  expect(
    framesBeforeTurnBody.some((frame) => frame.type === "update_loop_status"),
  ).toBe(true);

  // Turn end boundary: the same unconditional snapshots fire again after the
  // turn body, despite zero queue changes since turn start.
  expect(
    framesAfterTurnBody.some(
      (frame) =>
        frame.type === "update_queue" &&
        Array.isArray(frame.queue) &&
        frame.queue.length === 0 &&
        Array.isArray(frame.removed) &&
        frame.removed.length === 0,
    ),
  ).toBe(true);
  expect(
    framesAfterTurnBody.some((frame) => frame.type === "update_loop_status"),
  ).toBe(true);
});

test("boundary snapshots carry the turn's runtime scope", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const socket = new MockSocket();
  listener.socket = socket as unknown as WebSocket;
  setActiveRuntime(listener);

  expect(enqueueInboundUserMessage(runtime, queuedMessage("cm-scope"))).toBe(
    true,
  );

  let processedTurns = 0;
  scheduleQueuePump(
    runtime,
    socket as unknown as WebSocket,
    makeListenerOptions(),
    async () => {
      processedTurns += 1;
    },
  );
  await waitFor(() => processedTurns === 1 && !runtime.queuePumpActive);
  await Bun.sleep(5);

  const queueFrames = socket.sentPayloads
    .map((payload) => JSON.parse(payload) as Record<string, unknown>)
    .filter((frame) => frame.type === "update_queue");
  expect(queueFrames.length).toBeGreaterThanOrEqual(2);
  for (const frame of queueFrames) {
    expect(frame.runtime).toMatchObject({
      agent_id: "agent-1",
      conversation_id: "conv-1",
    });
  }
});
