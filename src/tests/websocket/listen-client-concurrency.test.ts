import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import WebSocket from "ws";

type MockStream = {
  conversationId: string;
  agentId?: string;
};

type DrainResult = {
  stopReason: string;
  approvals?: Array<{
    toolCallId: string;
    toolName: string;
    toolArgs: string;
  }>;
  apiDurationMs: number;
};

const defaultDrainResult: DrainResult = {
  stopReason: "end_turn",
  approvals: [],
  apiDurationMs: 0,
};

const sendMessageStreamMock = mock(
  async (
    conversationId: string,
    _messages: unknown[],
    opts?: { agentId?: string },
  ): Promise<MockStream> => ({
    conversationId,
    agentId: opts?.agentId,
  }),
);
const getStreamToolContextIdMock = mock(() => null);
const drainHandlers = new Map<
  string,
  (abortSignal?: AbortSignal) => Promise<DrainResult>
>();
const drainStreamWithResumeMock = mock(
  async (
    stream: MockStream,
    _buffers: unknown,
    _refresh: () => void,
    abortSignal?: AbortSignal,
  ) => {
    const handler = drainHandlers.get(stream.conversationId);
    if (handler) {
      return handler(abortSignal);
    }
    return defaultDrainResult;
  },
);
const cancelConversationMock = mock(async (_conversationId: string) => {});
const getClientMock = mock(async () => ({
  conversations: {
    cancel: cancelConversationMock,
  },
}));
const fetchRunErrorDetailMock = mock(async () => null);
const realStreamModule = await import("../../cli/helpers/stream");

mock.module("../../agent/message", () => ({
  sendMessageStream: sendMessageStreamMock,
  getStreamToolContextId: getStreamToolContextIdMock,
  getStreamRequestContext: () => undefined,
  getStreamRequestStartTime: () => undefined,
  buildConversationMessagesCreateRequestBody: (
    conversationId: string,
    messages: unknown[],
    opts?: { agentId?: string; streamTokens?: boolean; background?: boolean },
    clientTools?: unknown[],
    clientSkills?: unknown[],
  ) => ({
    messages,
    streaming: true,
    stream_tokens: opts?.streamTokens ?? true,
    include_pings: true,
    background: opts?.background ?? true,
    client_skills: clientSkills ?? [],
    client_tools: clientTools ?? [],
    include_compaction_messages: true,
    ...(conversationId === "default" && opts?.agentId
      ? { agent_id: opts.agentId }
      : {}),
  }),
}));

mock.module("../../cli/helpers/stream", () => ({
  ...realStreamModule,
  drainStreamWithResume: drainStreamWithResumeMock,
}));

mock.module("../../agent/client", () => ({
  getClient: getClientMock,
  getServerUrl: () => "https://example.test",
  clearLastSDKDiagnostic: () => {},
  consumeLastSDKDiagnostic: () => null,
}));

mock.module("../../agent/approval-recovery", () => ({
  fetchRunErrorDetail: fetchRunErrorDetailMock,
}));

const listenClientModule = await import("../../websocket/listen-client");
const { __listenClientTestUtils } = listenClientModule;

class MockSocket {
  readyState: number;
  sentPayloads: string[] = [];

  constructor(readyState: number = WebSocket.OPEN) {
    this.readyState = readyState;
  }

  send(data: string): void {
    this.sentPayloads.push(data);
  }

  close(): void {}

  removeAllListeners(): this {
    return this;
  }
}

function createDeferredDrain() {
  let resolve!: (value: DrainResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<DrainResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeIncomingMessage(
  agentId: string,
  conversationId: string,
  text: string,
) {
  return {
    type: "message" as const,
    agentId,
    conversationId,
    messages: [{ role: "user" as const, content: text }],
  };
}

describe("listen-client multi-worker concurrency", () => {
  beforeEach(() => {
    sendMessageStreamMock.mockClear();
    getStreamToolContextIdMock.mockClear();
    drainStreamWithResumeMock.mockClear();
    getClientMock.mockClear();
    cancelConversationMock.mockClear();
    fetchRunErrorDetailMock.mockClear();
    drainHandlers.clear();
    __listenClientTestUtils.setActiveRuntime(null);
  });

  afterEach(() => {
    __listenClientTestUtils.setActiveRuntime(null);
  });

  test("processes simultaneous turns for two named conversations under one agent", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtimeA = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    const runtimeB = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-b",
    );
    const socket = new MockSocket();
    const drainA = createDeferredDrain();
    const drainB = createDeferredDrain();
    drainHandlers.set("conv-a", () => drainA.promise);
    drainHandlers.set("conv-b", () => drainB.promise);

    const turnA = __listenClientTestUtils.handleIncomingMessage(
      makeIncomingMessage("agent-1", "conv-a", "hello a"),
      socket as unknown as WebSocket,
      runtimeA,
    );
    const turnB = __listenClientTestUtils.handleIncomingMessage(
      makeIncomingMessage("agent-1", "conv-b", "hello b"),
      socket as unknown as WebSocket,
      runtimeB,
    );

    await Promise.resolve();

    expect(runtimeA.isProcessing).toBe(true);
    expect(runtimeB.isProcessing).toBe(true);
    expect(__listenClientTestUtils.getListenerStatus(listener)).toBe(
      "processing",
    );
    expect(sendMessageStreamMock.mock.calls.map((call) => call[0])).toEqual([
      "conv-a",
      "conv-b",
    ]);

    drainB.resolve(defaultDrainResult);
    await turnB;
    expect(runtimeB.isProcessing).toBe(false);
    expect(runtimeA.isProcessing).toBe(true);
    expect(__listenClientTestUtils.getListenerStatus(listener)).toBe(
      "processing",
    );

    drainA.resolve(defaultDrainResult);
    await turnA;
    expect(runtimeA.isProcessing).toBe(false);
    expect(__listenClientTestUtils.getListenerStatus(listener)).toBe("idle");
  });

  test("keeps default conversations separate for different agents during concurrent turns", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtimeA = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-a",
      "default",
    );
    const runtimeB = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-b",
      "default",
    );
    const socket = new MockSocket();

    await Promise.all([
      __listenClientTestUtils.handleIncomingMessage(
        makeIncomingMessage("agent-a", "default", "from a"),
        socket as unknown as WebSocket,
        runtimeA,
      ),
      __listenClientTestUtils.handleIncomingMessage(
        makeIncomingMessage("agent-b", "default", "from b"),
        socket as unknown as WebSocket,
        runtimeB,
      ),
    ]);

    expect(sendMessageStreamMock.mock.calls).toHaveLength(2);
    expect(sendMessageStreamMock.mock.calls[0]?.[0]).toBe("default");
    expect(sendMessageStreamMock.mock.calls[1]?.[0]).toBe("default");
    expect(sendMessageStreamMock.mock.calls[0]?.[2]).toMatchObject({
      agentId: "agent-a",
    });
    expect(sendMessageStreamMock.mock.calls[1]?.[2]).toMatchObject({
      agentId: "agent-b",
    });
  });

  test("cancelling one active worker does not interrupt another", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtimeA = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    const runtimeB = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-b",
    );
    const socket = new MockSocket();
    const drainA = createDeferredDrain();
    const drainB = createDeferredDrain();
    drainHandlers.set("conv-a", (abortSignal) => {
      if (abortSignal?.aborted) {
        drainA.reject(new Error("aborted"));
        return drainA.promise;
      }
      abortSignal?.addEventListener(
        "abort",
        () => {
          drainA.reject(new Error("aborted"));
        },
        { once: true },
      );
      return drainA.promise;
    });
    drainHandlers.set("conv-b", () => drainB.promise);

    const turnA = __listenClientTestUtils.handleIncomingMessage(
      makeIncomingMessage("agent-1", "conv-a", "cancel me"),
      socket as unknown as WebSocket,
      runtimeA,
    );
    const turnB = __listenClientTestUtils.handleIncomingMessage(
      makeIncomingMessage("agent-1", "conv-b", "let me finish"),
      socket as unknown as WebSocket,
      runtimeB,
    );

    await Promise.resolve();
    runtimeA.cancelRequested = true;
    runtimeA.activeAbortController?.abort();
    drainB.resolve(defaultDrainResult);

    await Promise.all([turnA, turnB]);

    expect(runtimeA.lastStopReason).toBe("cancelled");
    expect(runtimeB.lastStopReason).toBe("end_turn");

    const results = socket.sentPayloads
      .map((payload) => JSON.parse(payload))
      .filter((payload) => payload.type === "result");
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subtype: "interrupted",
          conversation_id: "conv-a",
        }),
        expect.objectContaining({
          subtype: "success",
          conversation_id: "conv-b",
        }),
      ]),
    );
  });

  test("worker-scoped failure emissions stay attributed on pre-run errors", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    const socket = new MockSocket();

    sendMessageStreamMock.mockImplementationOnce(async () => {
      throw new Error("pre-run failure");
    });

    await __listenClientTestUtils.handleIncomingMessage(
      makeIncomingMessage("agent-1", "conv-a", "trigger error"),
      socket as unknown as WebSocket,
      runtime,
    );

    const payloads = socket.sentPayloads.map((payload) => JSON.parse(payload));
    const runRequestError = payloads.find(
      (payload) => payload.type === "run_request_error",
    );
    expect(runRequestError).toBeDefined();
    expect(runRequestError.agent_id).toBe("agent-1");
    expect(runRequestError.conversation_id).toBe("conv-a");

    const genericError = payloads.find(
      (payload) =>
        payload.type === "error" && payload.message === "pre-run failure",
    );
    expect(genericError).toBeDefined();
    expect(genericError.agent_id).toBe("agent-1");
    expect(genericError.conversation_id).toBe("conv-a");
  });

  test("a pending approval in one worker does not block another worker queue pump", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtimeA = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    const runtimeB = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-b",
    );
    const socket = new MockSocket();
    listener.socket = socket as unknown as WebSocket;
    __listenClientTestUtils.setActiveRuntime(listener);

    runtimeA.pendingApprovalResolvers.set("perm-a", {
      resolve: () => {},
      reject: () => {},
    });

    const queued = makeIncomingMessage("agent-1", "conv-b", "queued turn");
    const enqueuedItem = runtimeB.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "queued turn",
      clientMessageId: "cm-queued",
    } as Parameters<typeof runtimeB.queueRuntime.enqueue>[0]);
    if (!enqueuedItem) {
      throw new Error("Failed to enqueue worker message");
    }
    runtimeB.queuedMessagesByItemId.set(enqueuedItem.id, queued);

    __listenClientTestUtils.scheduleQueuePump(
      runtimeB,
      socket as unknown as WebSocket,
      {
        wsUrl: "wss://example.test",
        deviceId: "device-1",
        connectionId: "conn-1",
        connectionName: "listener-test",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
    );

    await runtimeB.messageQueue;

    expect(sendMessageStreamMock).toHaveBeenCalledTimes(1);
    expect(sendMessageStreamMock.mock.calls[0]?.[0]).toBe("conv-b");
    expect(runtimeA.pendingApprovalResolvers.size).toBe(1);
    expect(runtimeB.pendingTurns).toBe(0);
  });

  test("a recovering worker does not block another worker queue pump", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtimeA = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    const runtimeB = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-b",
    );
    const socket = new MockSocket();
    listener.socket = socket as unknown as WebSocket;
    __listenClientTestUtils.setActiveRuntime(listener);

    runtimeA.isRecoveringApprovals = true;
    const queued = makeIncomingMessage("agent-1", "conv-b", "queued turn");
    const enqueuedItem = runtimeB.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "queued turn",
      clientMessageId: "cm-queued-recovering",
    } as Parameters<typeof runtimeB.queueRuntime.enqueue>[0]);
    if (!enqueuedItem) {
      throw new Error("Failed to enqueue worker message");
    }
    runtimeB.queuedMessagesByItemId.set(enqueuedItem.id, queued);

    __listenClientTestUtils.scheduleQueuePump(
      runtimeB,
      socket as unknown as WebSocket,
      {
        wsUrl: "wss://example.test",
        deviceId: "device-1",
        connectionId: "conn-1",
        connectionName: "listener-test",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
    );

    await runtimeB.messageQueue;

    expect(sendMessageStreamMock).toHaveBeenCalledTimes(1);
    expect(sendMessageStreamMock.mock.calls[0]?.[0]).toBe("conv-b");
    expect(runtimeA.isRecoveringApprovals).toBe(true);
    expect(runtimeB.pendingTurns).toBe(0);
  });

  test("state snapshots remain conversation-scoped under concurrent worker state", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtimeA = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    const runtimeB = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-b",
    );

    runtimeA.isProcessing = true;
    runtimeA.activeRunId = "run-a";
    runtimeA.activeRunStartedAt = new Date().toISOString();
    runtimeA.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: "queued for a",
      clientMessageId: "cm-a",
    } as Parameters<typeof runtimeA.queueRuntime.enqueue>[0]);

    const snapshotA = __listenClientTestUtils.buildStateResponse(runtimeA, 11);
    const snapshotB = __listenClientTestUtils.buildStateResponse(runtimeB, 12);

    expect(snapshotA.agent_id).toBe("agent-1");
    expect(snapshotA.conversation_id).toBe("conv-a");
    expect(snapshotA.active_run.run_id).toBe("run-a");
    expect(snapshotA.queue.queue_len).toBeGreaterThan(0);

    expect(snapshotB.agent_id).toBe("agent-1");
    expect(snapshotB.conversation_id).toBe("conv-b");
    expect(snapshotB.active_run.run_id).toBeNull();
    expect(snapshotB.queue.queue_len).toBe(0);
  });
});
