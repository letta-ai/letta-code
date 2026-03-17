import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import WebSocket from "ws";
import { permissionMode } from "../../permissions/mode";
import type { MessageQueueItem } from "../../queue/queueRuntime";

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
const {
  __listenClientTestUtils,
  requestApprovalOverWS,
  resolvePendingApprovalResolver,
} = listenClientModule;

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

async function waitFor(
  predicate: () => boolean,
  attempts: number = 20,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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
    permissionMode.reset();
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
    permissionMode.reset();
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

    await waitFor(() => sendMessageStreamMock.mock.calls.length === 2);

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

  test("cancelling one conversation runtime does not cancel another", async () => {
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
    runtimeA.activeAbortController = new AbortController();
    runtimeB.isProcessing = true;
    runtimeB.activeAbortController = new AbortController();

    runtimeA.cancelRequested = true;
    runtimeA.activeAbortController.abort();

    expect(runtimeA.activeAbortController.signal.aborted).toBe(true);
    expect(runtimeB.activeAbortController.signal.aborted).toBe(false);
    expect(runtimeB.cancelRequested).toBe(false);
  });

  test("approval waits and resolver routing stay isolated per conversation", async () => {
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

    const pendingA = requestApprovalOverWS(
      runtimeA,
      socket as unknown as WebSocket,
      "perm-a",
      {
        type: "control_request",
        request_id: "perm-a",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: {},
          tool_call_id: "call-a",
          permission_suggestions: [],
          blocked_path: null,
        },
      },
    );
    const pendingB = requestApprovalOverWS(
      runtimeB,
      socket as unknown as WebSocket,
      "perm-b",
      {
        type: "control_request",
        request_id: "perm-b",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: {},
          tool_call_id: "call-b",
          permission_suggestions: [],
          blocked_path: null,
        },
      },
    );

    expect(listener.approvalRuntimeKeyByRequestId.get("perm-a")).toBe(
      runtimeA.key,
    );
    expect(listener.approvalRuntimeKeyByRequestId.get("perm-b")).toBe(
      runtimeB.key,
    );

    const statusAWhilePending = __listenClientTestUtils.buildLoopStatus(
      listener,
      {
        agent_id: "agent-1",
        conversation_id: "conv-a",
      },
    );
    const statusBWhilePending = __listenClientTestUtils.buildLoopStatus(
      listener,
      {
        agent_id: "agent-1",
        conversation_id: "conv-b",
      },
    );
    expect(statusAWhilePending.status).toBe("WAITING_ON_APPROVAL");
    expect(statusBWhilePending.status).toBe("WAITING_ON_APPROVAL");

    expect(
      resolvePendingApprovalResolver(runtimeA, {
        request_id: "perm-a",
        decision: { behavior: "allow" },
      }),
    ).toBe(true);

    await expect(pendingA).resolves.toMatchObject({
      request_id: "perm-a",
      decision: { behavior: "allow" },
    });
    expect(runtimeA.pendingApprovalResolvers.size).toBe(0);
    expect(runtimeB.pendingApprovalResolvers.size).toBe(1);
    expect(listener.approvalRuntimeKeyByRequestId.has("perm-a")).toBe(false);
    expect(listener.approvalRuntimeKeyByRequestId.get("perm-b")).toBe(
      runtimeB.key,
    );

    const statusAAfterResolve = __listenClientTestUtils.buildLoopStatus(
      listener,
      {
        agent_id: "agent-1",
        conversation_id: "conv-a",
      },
    );
    const statusBAfterResolve = __listenClientTestUtils.buildLoopStatus(
      listener,
      {
        agent_id: "agent-1",
        conversation_id: "conv-b",
      },
    );
    expect(statusAAfterResolve.status).toBe("WAITING_ON_INPUT");
    expect(statusBAfterResolve.status).toBe("WAITING_ON_APPROVAL");

    expect(
      resolvePendingApprovalResolver(runtimeB, {
        request_id: "perm-b",
        decision: { behavior: "allow" },
      }),
    ).toBe(true);
    await expect(pendingB).resolves.toMatchObject({
      request_id: "perm-b",
      decision: { behavior: "allow" },
    });
  });

  test("recovered approval state does not leak across conversation scopes", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtimeA = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-1",
      "conv-b",
    );

    runtimeA.recoveredApprovalState = {
      agentId: "agent-1",
      conversationId: "conv-a",
      approvalsByRequestId: new Map([
        [
          "perm-a",
          {
            approval: {
              toolCallId: "call-a",
              toolName: "Bash",
              toolArgs: "{}",
            },
            controlRequest: {
              type: "control_request",
              request_id: "perm-a",
              request: {
                subtype: "can_use_tool",
                tool_name: "Bash",
                input: {},
                tool_call_id: "call-a",
                permission_suggestions: [],
                blocked_path: null,
              },
            },
          },
        ],
      ]),
      pendingRequestIds: new Set(["perm-a"]),
      responsesByRequestId: new Map(),
    };

    const loopStatusA = __listenClientTestUtils.buildLoopStatus(listener, {
      agent_id: "agent-1",
      conversation_id: "conv-a",
    });
    const loopStatusB = __listenClientTestUtils.buildLoopStatus(listener, {
      agent_id: "agent-1",
      conversation_id: "conv-b",
    });
    const deviceStatusA = __listenClientTestUtils.buildDeviceStatus(listener, {
      agent_id: "agent-1",
      conversation_id: "conv-a",
    });
    const deviceStatusB = __listenClientTestUtils.buildDeviceStatus(listener, {
      agent_id: "agent-1",
      conversation_id: "conv-b",
    });

    expect(loopStatusA.status).toBe("WAITING_ON_APPROVAL");
    expect(loopStatusB.status).toBe("WAITING_ON_INPUT");
    expect(deviceStatusA.pending_control_requests).toHaveLength(1);
    expect(deviceStatusA.pending_control_requests[0]?.request_id).toBe(
      "perm-a",
    );
    expect(deviceStatusB.pending_control_requests).toHaveLength(0);
  });

  test("queue dispatch respects conversation runtime boundaries", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.setActiveRuntime(listener);
    const runtimeA = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    const runtimeB = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-b",
    );
    const socket = new MockSocket();
    const processed: string[] = [];

    const enqueueTurn = (
      runtime: (typeof runtimeA | typeof runtimeB) & {
        queueRuntime: {
          enqueue: (item: {
            kind: "message";
            source: "user";
            content: string;
            clientMessageId: string;
            agentId: string;
            conversationId: string;
          }) => { id: string } | null;
        };
      },
      conversationId: string,
      text: string,
    ) => {
      const item = runtime.queueRuntime.enqueue({
        kind: "message",
        source: "user",
        content: text,
        clientMessageId: `cm-${conversationId}`,
        agentId: "agent-1",
        conversationId,
      });
      if (!item) {
        throw new Error("Expected queued item to be created");
      }
      runtime.queuedMessagesByItemId.set(
        item.id,
        makeIncomingMessage("agent-1", conversationId, text),
      );
    };

    enqueueTurn(runtimeA, "conv-a", "queued a");
    enqueueTurn(runtimeB, "conv-b", "queued b");

    const processQueuedTurn = mock(
      async (queuedTurn: { conversationId?: string }) => {
        processed.push(queuedTurn.conversationId ?? "missing");
      },
    );
    const opts = {
      connectionId: "conn-1",
      onStatusChange: undefined,
    } as never;

    __listenClientTestUtils.scheduleQueuePump(
      runtimeA,
      socket as unknown as WebSocket,
      opts,
      processQueuedTurn,
    );
    __listenClientTestUtils.scheduleQueuePump(
      runtimeB,
      socket as unknown as WebSocket,
      opts,
      processQueuedTurn,
    );

    await waitFor(() => processed.length === 2);

    expect(processed.sort()).toEqual(["conv-a", "conv-b"]);
    expect(runtimeA.queueRuntime.length).toBe(0);
    expect(runtimeB.queueRuntime.length).toBe(0);
    expect(runtimeA.queuedMessagesByItemId.size).toBe(0);
    expect(runtimeB.queuedMessagesByItemId.size).toBe(0);
  });

  test("queue pump status callbacks stay aggregate when another conversation is busy", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.setActiveRuntime(listener);
    const runtimeA = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    const runtimeB = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-b",
    );
    const socket = new MockSocket();
    const statuses: string[] = [];

    runtimeA.isProcessing = true;
    runtimeA.loopStatus = "PROCESSING_API_RESPONSE";

    const queueInput = {
      kind: "message",
      source: "user",
      content: "queued b",
      clientMessageId: "cm-b",
      agentId: "agent-1",
      conversationId: "conv-b",
    } satisfies Omit<MessageQueueItem, "id" | "enqueuedAt">;
    const item = runtimeB.queueRuntime.enqueue(queueInput);
    if (!item) {
      throw new Error("Expected queued item to be created");
    }
    runtimeB.queuedMessagesByItemId.set(
      item.id,
      makeIncomingMessage("agent-1", "conv-b", "queued b"),
    );

    __listenClientTestUtils.scheduleQueuePump(
      runtimeB,
      socket as unknown as WebSocket,
      {
        connectionId: "conn-1",
        onStatusChange: (status: "idle" | "receiving" | "processing") => {
          statuses.push(status);
        },
      } as never,
      async () => {},
    );

    await waitFor(() => runtimeB.queueRuntime.length === 0);

    expect(statuses).not.toContain("idle");
    expect(statuses.every((status) => status === "processing")).toBe(true);
    expect(listener.conversationRuntimes.has(runtimeB.key)).toBe(false);
    expect(listener.conversationRuntimes.has(runtimeA.key)).toBe(true);
  });
});
