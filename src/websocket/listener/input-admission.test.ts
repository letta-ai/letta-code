import { afterEach, expect, mock, test } from "bun:test";
import type WebSocket from "ws";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { dispatchInboundMessageWhenReady } from "./inbound-dispatch";
import {
  getInputDisposition,
  ordinaryInputIdentity,
  rememberInputDisposition,
  teleportInputIdentity,
} from "./input-disposition";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { setActiveRuntime } from "./runtime";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerRuntime,
  PendingTeleport,
  StartListenerOptions,
} from "./types";

const socket = {
  readyState: 1,
  bufferedAmount: 0,
  isOpen: () => true,
  send: () => {},
};

function makeOptions(): StartListenerOptions {
  return {
    connectionId: "conn-admission",
    wsUrl: "local://test",
    deviceId: "device",
    connectionName: "test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

function incoming(clientMessageId: string): IncomingMessage {
  return {
    type: "message",
    agentId: "agent-1",
    conversationId: "conversation-1",
    messages: [
      {
        role: "user",
        content: clientMessageId,
        client_message_id: clientMessageId,
      },
    ],
  };
}

function parkQueueItem(runtime: ConversationRuntime, content: string): void {
  runtime.queueRuntime.enqueue({
    kind: "message",
    source: "user",
    content,
    clientMessageId: `cm-${content}`,
    agentId: "agent-1",
    conversationId: "conversation-1",
  } as Parameters<typeof runtime.queueRuntime.enqueue>[0]);
}

/** Fails one enqueue, then behaves normally, so the retry can be observed. */
function failNextQueueWrite(runtime: ConversationRuntime): void {
  const realEnqueue = runtime.queueRuntime.enqueue.bind(runtime.queueRuntime);
  let armed = true;
  runtime.queueRuntime.enqueue = ((
    item: Parameters<typeof runtime.queueRuntime.enqueue>[0],
  ) => {
    if (armed) {
      armed = false;
      throw new Error("queue write failed");
    }
    return realEnqueue(item);
  }) as typeof runtime.queueRuntime.enqueue;
}

/** Fails one read of listener teleport state from inside the admitted region. */
function faultyTeleportMap(): Map<string, PendingTeleport> {
  const pendingTeleports = new Map<string, PendingTeleport>();
  const realIterator = pendingTeleports[Symbol.iterator].bind(pendingTeleports);
  let armed = true;
  Object.defineProperty(pendingTeleports, Symbol.iterator, {
    configurable: true,
    value: () => {
      if (armed) {
        armed = false;
        throw new Error("teleport state read failed");
      }
      return realIterator();
    },
  });
  return pendingTeleports;
}

function setupRouter(params: {
  listener: ListenerRuntime;
  runtime: ConversationRuntime;
  sent: unknown[];
  tasks: Promise<void>[];
  trackListenerError: (
    errorType: string,
    error: unknown,
    context: string,
  ) => void;
  processIncomingMessage: (incoming: IncomingMessage) => Promise<void>;
}): (data: WebSocket.RawData) => Promise<void> {
  const options = makeOptions();
  const connection = openListenerConnection({
    runtime: params.listener,
    connectionId: options.connectionId,
    writer: socket as unknown as WebSocket,
    options,
  });
  markListenerConnectionInitialized(
    params.listener,
    options.connectionId,
    connection,
  );
  setActiveRuntime(params.listener);
  return createListenerMessageHandler({
    runtime: params.listener,
    socket: socket as unknown as WebSocket,
    opts: options,
    processQueuedTurn: async () => {},
    fileCommandSession: { handle: () => false },
    getParsedRuntimeScope: () => null,
    replaySyncStateForRuntime: async () => {},
    getOrCreateScopedRuntime: () => params.runtime,
    handleApprovalResponseInput: async () => false,
    handleChangeDeviceStateInput: async () => false,
    handleAbortMessageInput: async () => false,
    stampInboundUserMessageOtids: (message) => message,
    safeSocketSend: (_target, payload) => {
      params.sent.push(payload);
      return true;
    },
    runDetachedListenerTask: (_name, task) => {
      params.tasks.push(task());
    },
    trackListenerError: params.trackListenerError,
    processIncomingMessage: params.processIncomingMessage as never,
  });
}

function createMessageFrame(
  requestId: string,
  clientMessageId: string,
): Buffer {
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

function teleportContinueFrame(requestId: string, teleportId: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: "input",
      request_id: requestId,
      runtime: { agent_id: "agent-1", conversation_id: "conversation-1" },
      payload: {
        kind: "teleport_continue",
        teleport_id: teleportId,
        source: { device_id: "away", connection_name: "Away" },
      },
    }),
  );
}

afterEach(() => setActiveRuntime(null));

test("ordinary and teleport identities never share a ledger key", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );

  rememberInputDisposition(runtime, teleportInputIdentity("tp-1"), "started");
  // A client is free to choose any stable id, including one that is spelled
  // like the teleport ledger key. It must not observe or occupy the teleport
  // domain's entry.
  expect(
    getInputDisposition(runtime, ordinaryInputIdentity("teleport:tp-1")),
  ).toBeUndefined();
  expect(
    getInputDisposition(runtime, ordinaryInputIdentity("tp-1")),
  ).toBeUndefined();
  expect(
    rememberInputDisposition(
      runtime,
      ordinaryInputIdentity("teleport:tp-1"),
      "queued",
    ),
  ).toBe(true);

  expect(getInputDisposition(runtime, teleportInputIdentity("tp-1"))).toBe(
    "started",
  );
  expect(
    getInputDisposition(runtime, ordinaryInputIdentity("teleport:tp-1")),
  ).toBe("queued");
  expect(listener.acceptedInputDispositionLedger.entries.size).toBe(2);
});

test("a teleport continuation is not suppressed by a colliding client message id", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const sent: unknown[] = [];
  const tasks: Promise<void>[] = [];
  const processIncomingMessage = mock(async (_message: IncomingMessage) => {});
  const handleMessage = setupRouter({
    listener,
    runtime,
    sent,
    tasks,
    trackListenerError: () => {},
    processIncomingMessage,
  });
  // A parked item keeps the create_message on the queue path.
  parkQueueItem(runtime, "parked");

  await handleMessage(createMessageFrame("collide", "teleport:tp-1"));
  await handleMessage(teleportContinueFrame("continue", "tp-1"));
  await handleMessage(createMessageFrame("collide-retry", "teleport:tp-1"));
  await handleMessage(teleportContinueFrame("continue-retry", "tp-1"));
  await Promise.all(tasks);

  expect(sent).toContainEqual(
    expect.objectContaining({
      request_id: "collide",
      accepted: true,
      disposition: "queued",
    }),
  );
  expect(sent).toContainEqual(
    expect.objectContaining({
      request_id: "continue",
      accepted: true,
      disposition: "started",
    }),
  );
  expect(sent).toContainEqual(
    expect.objectContaining({
      request_id: "collide-retry",
      accepted: true,
      disposition: "queued",
    }),
  );
  expect(sent).toContainEqual(
    expect.objectContaining({
      request_id: "continue-retry",
      accepted: true,
      disposition: "started",
    }),
  );
  expect(processIncomingMessage).toHaveBeenCalledTimes(1);
  expect(listener.acceptedInputDispositionLedger.entries.size).toBe(2);
});

test("a throwing status callback rejects then recovers the same id exactly once", async () => {
  const listener = createRuntime();
  setActiveRuntime(listener);
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  let throwStatus = true;
  const options: StartListenerOptions = {
    ...makeOptions(),
    onStatusChange: () => {
      if (throwStatus) {
        throwStatus = false;
        throw new Error("hostile status callback");
      }
    },
  };
  const acknowledgements: Array<{
    accepted: boolean;
    disposition?: "started" | "queued";
  }> = [];
  const trackListenerError = mock(() => {});
  const processIncomingMessage = mock(async () => {});
  const dispatch = (): void =>
    dispatchInboundMessageWhenReady({
      listener,
      runtime,
      incoming: incoming("cm-status-boom"),
      socket: {
        kind: "local",
        bufferedAmount: 0,
        isOpen: () => true,
        send: () => {},
      },
      options,
      processQueuedTurn: async () => {},
      processIncomingMessage,
      trackListenerError,
      onInputAccepted: (ack) => acknowledgements.push(ack),
    });

  dispatch();
  await runtime.messageQueue;
  expect(trackListenerError).toHaveBeenCalledTimes(1);
  expect(acknowledgements).toEqual([{ accepted: false }]);
  expect(processIncomingMessage).not.toHaveBeenCalled();
  expect(
    getInputDisposition(runtime, ordinaryInputIdentity("cm-status-boom")),
  ).toBeUndefined();
  expect(listener.acceptedInputDispositionLedger.entries.size).toBe(0);
  expect(listener.acceptedInputDispositionLedger.scopeCounts.size).toBe(0);

  dispatch();
  await runtime.messageQueue;
  expect(acknowledgements).toEqual([
    { accepted: false },
    { accepted: true, disposition: "started" },
  ]);
  expect(processIncomingMessage).toHaveBeenCalledTimes(1);
  expect(
    getInputDisposition(runtime, ordinaryInputIdentity("cm-status-boom")),
  ).toBe("started");

  dispatch();
  await runtime.messageQueue;
  expect(processIncomingMessage).toHaveBeenCalledTimes(1);
  expect(acknowledgements.at(-1)).toEqual({
    accepted: true,
    disposition: "started",
  });
  expect(listener.acceptedInputDispositionLedger.entries.size).toBe(1);
  expect(
    listener.acceptedInputDispositionLedger.scopeCounts.get(runtime.key),
  ).toBe(1);
});

test("a queue admission that throws after admission releases its reservation", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const sent: unknown[] = [];
  const tasks: Promise<void>[] = [];
  const trackListenerError = mock(() => {});
  const handleMessage = setupRouter({
    listener,
    runtime,
    sent,
    tasks,
    trackListenerError,
    processIncomingMessage: async () => {},
  });
  parkQueueItem(runtime, "parked");
  failNextQueueWrite(runtime);

  await handleMessage(createMessageFrame("queue-boom", "cm-queue-boom"));

  expect(trackListenerError).toHaveBeenCalled();
  expect(
    getInputDisposition(runtime, ordinaryInputIdentity("cm-queue-boom")),
  ).toBeUndefined();

  await handleMessage(createMessageFrame("queue-retry", "cm-queue-boom"));
  expect(sent).toContainEqual(
    expect.objectContaining({
      request_id: "queue-retry",
      accepted: true,
      disposition: "queued",
    }),
  );
});

test("a teleport admission that throws after admission releases its reservation", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const sent: unknown[] = [];
  const tasks: Promise<void>[] = [];
  const trackListenerError = mock(() => {});
  const processIncomingMessage = mock(async (_message: IncomingMessage) => {});
  const handleMessage = setupRouter({
    listener,
    runtime,
    sent,
    tasks,
    trackListenerError,
    processIncomingMessage,
  });
  listener.pendingTeleports = faultyTeleportMap();

  await handleMessage(teleportContinueFrame("tp-boom", "tp-1"));

  expect(trackListenerError).toHaveBeenCalled();
  expect(processIncomingMessage).not.toHaveBeenCalled();
  expect(
    getInputDisposition(runtime, teleportInputIdentity("tp-1")),
  ).toBeUndefined();

  // Cloud retries the same teleport id; a leaked placeholder would answer
  // "Stable input ledger is at capacity" and strand the conversation.
  await handleMessage(teleportContinueFrame("tp-retry", "tp-1"));
  await Promise.all(tasks);

  expect(sent).toContainEqual(
    expect.objectContaining({
      request_id: "tp-retry",
      accepted: true,
      disposition: "started",
    }),
  );
  expect(processIncomingMessage).toHaveBeenCalledTimes(1);
});
