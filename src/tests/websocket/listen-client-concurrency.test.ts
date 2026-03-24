import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import WebSocket from "ws";
import type { ResumeData } from "../../agent/check-approval";
import { permissionMode } from "../../permissions/mode";
import type {
  MessageQueueItem,
  TaskNotificationQueueItem,
} from "../../queue/queueRuntime";
import type { IncomingMessage } from "../../websocket/listener/types";

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
const retrieveAgentMock = mock(async (agentId: string) => ({ id: agentId }));
const cancelConversationMock = mock(async (_conversationId: string) => {});
const getClientMock = mock(async () => ({
  agents: {
    retrieve: retrieveAgentMock,
  },
  conversations: {
    cancel: cancelConversationMock,
  },
}));
const getResumeDataMock = mock(
  async (): Promise<ResumeData> => ({
    pendingApproval: null,
    pendingApprovals: [],
    messageHistory: [],
  }),
);
const classifyApprovalsMock = mock(async () => ({
  autoAllowed: [],
  autoDenied: [],
  needsUserInput: [],
}));
const executeApprovalBatchMock = mock(async () => []);
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

mock.module("../../cli/helpers/approvalClassification", () => ({
  classifyApprovals: classifyApprovalsMock,
}));

mock.module("../../agent/approval-execution", () => ({
  executeApprovalBatch: executeApprovalBatchMock,
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
    retrieveAgentMock.mockClear();
    getResumeDataMock.mockClear();
    classifyApprovalsMock.mockClear();
    executeApprovalBatchMock.mockClear();
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

  test("consumeQueuedTurn only drains the next same-scope queued turn batch", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    const messageInput = {
      kind: "message",
      source: "user",
      content: "queued user",
      clientMessageId: "cm-user",
      agentId: "agent-1",
      conversationId: "conv-1",
    } satisfies Omit<MessageQueueItem, "id" | "enqueuedAt">;
    const messageItem = runtime.queueRuntime.enqueue(messageInput);

    if (!messageItem) {
      throw new Error("Expected queued message item");
    }

    runtime.queuedMessagesByItemId.set(
      messageItem.id,
      makeIncomingMessage("agent-1", "conv-1", "queued user"),
    );

    const taskInput = {
      kind: "task_notification",
      source: "system",
      text: "<task-notification>done</task-notification>",
      clientMessageId: "cm-task",
      agentId: "agent-1",
      conversationId: "conv-1",
    } satisfies Omit<TaskNotificationQueueItem, "id" | "enqueuedAt">;
    const taskItem = runtime.queueRuntime.enqueue(taskInput);

    if (!taskItem) {
      throw new Error("Expected queued task notification item");
    }

    const otherMessageInput = {
      kind: "message",
      source: "user",
      content: "queued other",
      clientMessageId: "cm-other",
      agentId: "agent-1",
      conversationId: "conv-2",
    } satisfies Omit<MessageQueueItem, "id" | "enqueuedAt">;
    const otherMessageItem = runtime.queueRuntime.enqueue(otherMessageInput);

    if (!otherMessageItem) {
      throw new Error("Expected second queued message item");
    }

    runtime.queuedMessagesByItemId.set(
      otherMessageItem.id,
      makeIncomingMessage("agent-1", "conv-2", "queued other"),
    );

    const consumed = __listenClientTestUtils.consumeQueuedTurn(runtime);

    expect(consumed).not.toBeNull();
    expect(
      consumed?.dequeuedBatch.items.map((item: { id: string }) => item.id),
    ).toEqual([messageItem.id, taskItem.id]);
    expect(consumed?.queuedTurn.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "queued user" },
          { type: "text", text: "\n" },
          {
            type: "text",
            text: "<task-notification>done</task-notification>",
          },
        ],
      },
    ]);
    expect(runtime.queueRuntime.length).toBe(1);
    expect(runtime.queuedMessagesByItemId.has(otherMessageItem.id)).toBe(true);
  });

  test("resolveStaleApprovals injects queued turns and marks recovery drain as processing", async () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.agentId = "agent-1";
    runtime.conversationId = "conv-1";
    runtime.activeWorkingDirectory = "/tmp/project";
    runtime.loopStatus = "WAITING_FOR_API_RESPONSE";
    const socket = new MockSocket();
    const drain = createDeferredDrain();
    drainHandlers.set("conv-1", () => drain.promise);

    const approval = {
      toolCallId: "tool-call-1",
      toolName: "Write",
      toolArgs: '{"file_path":"foo.ts"}',
    };
    const approvalResult = {
      type: "tool",
      tool_call_id: "tool-call-1",
      tool_return: "ok",
      status: "success",
    };

    getResumeDataMock.mockResolvedValueOnce({
      pendingApproval: approval,
      pendingApprovals: [approval],
      messageHistory: [],
    });
    classifyApprovalsMock.mockResolvedValueOnce({
      autoAllowed: [
        {
          approval,
          parsedArgs: { file_path: "foo.ts" },
        },
      ],
      autoDenied: [],
      needsUserInput: [],
    } as never);
    executeApprovalBatchMock.mockResolvedValueOnce([approvalResult] as never);

    const queuedMessageInput = {
      kind: "message",
      source: "user",
      content: "queued user",
      clientMessageId: "cm-stale-user",
      agentId: "agent-1",
      conversationId: "conv-1",
    } satisfies Omit<MessageQueueItem, "id" | "enqueuedAt">;
    const queuedMessageItem = runtime.queueRuntime.enqueue(queuedMessageInput);
    if (!queuedMessageItem) {
      throw new Error("Expected stale recovery queued message item");
    }
    runtime.queuedMessagesByItemId.set(
      queuedMessageItem.id,
      makeIncomingMessage("agent-1", "conv-1", "queued user"),
    );

    const queuedTaskInput = {
      kind: "task_notification",
      source: "system",
      text: "<task-notification>done</task-notification>",
      clientMessageId: "cm-stale-task",
      agentId: "agent-1",
      conversationId: "conv-1",
    } satisfies Omit<TaskNotificationQueueItem, "id" | "enqueuedAt">;
    const queuedTaskItem = runtime.queueRuntime.enqueue(queuedTaskInput);
    if (!queuedTaskItem) {
      throw new Error("Expected stale recovery queued task item");
    }

    const recoveryPromise = __listenClientTestUtils.resolveStaleApprovals(
      runtime,
      socket as unknown as WebSocket,
      new AbortController().signal,
      { getResumeData: getResumeDataMock },
    );

    await waitFor(() => sendMessageStreamMock.mock.calls.length === 1);
    await waitFor(() => drainStreamWithResumeMock.mock.calls.length === 1);

    const continuationMessages = sendMessageStreamMock.mock.calls[0]?.[1] as
      | Array<Record<string, unknown>>
      | undefined;
    expect(continuationMessages).toHaveLength(2);
    expect(continuationMessages?.[0]).toEqual({
      type: "approval",
      approvals: [approvalResult],
    });
    expect(continuationMessages?.[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "queued user" },
        { type: "text", text: "\n" },
        {
          type: "text",
          text: "<task-notification>done</task-notification>",
        },
      ],
    });
    expect(runtime.loopStatus as string).toBe("PROCESSING_API_RESPONSE");
    expect(runtime.queueRuntime.length).toBe(0);
    expect(runtime.queuedMessagesByItemId.size).toBe(0);
    expect(
      socket.sentPayloads.some(
        (payload) =>
          payload.includes("queued user") &&
          payload.includes("<task-notification>done</task-notification>"),
      ),
    ).toBe(true);

    drain.resolve({
      stopReason: "end_turn",
      approvals: [],
      apiDurationMs: 0,
    });

    await expect(recoveryPromise).resolves.toEqual({
      stopReason: "end_turn",
      approvals: [],
      apiDurationMs: 0,
    });
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

  test("change_device_state command holds queued input until the tracked command completes", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.setActiveRuntime(listener);
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    const socket = new MockSocket();
    const processedTurns: string[] = [];

    const queueInput = {
      kind: "message",
      source: "user",
      content: "queued during command",
      clientMessageId: "cm-command",
      agentId: "agent-1",
      conversationId: "conv-a",
    } satisfies Omit<MessageQueueItem, "id" | "enqueuedAt">;
    const item = runtime.queueRuntime.enqueue(queueInput);
    if (!item) {
      throw new Error("Expected queued item to be created");
    }
    runtime.queuedMessagesByItemId.set(
      item.id,
      makeIncomingMessage("agent-1", "conv-a", "queued during command"),
    );

    let releaseCommand!: () => void;
    const commandHold = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const processQueuedTurn = async (
      queuedTurn: IncomingMessage,
      _dequeuedBatch: unknown,
    ) => {
      processedTurns.push(queuedTurn.conversationId ?? "default");
    };

    const commandPromise = __listenClientTestUtils.handleChangeDeviceStateInput(
      listener,
      {
        command: {
          type: "change_device_state",
          runtime: { agent_id: "agent-1", conversation_id: "conv-a" },
          payload: { cwd: "/tmp/next" },
        },
        socket: socket as unknown as WebSocket,
        opts: {},
        processQueuedTurn,
      },
      {
        handleCwdChange: async () => {
          await commandHold;
        },
      },
    );

    await waitFor(() => runtime.loopStatus === "EXECUTING_COMMAND");

    __listenClientTestUtils.scheduleQueuePump(
      runtime,
      socket as unknown as WebSocket,
      {} as never,
      processQueuedTurn,
    );

    await waitFor(
      () =>
        runtime.queueRuntime.length === 1 &&
        !runtime.queuePumpScheduled &&
        !runtime.queuePumpActive,
    );

    expect(processedTurns).toEqual([]);
    expect(runtime.queueRuntime.length).toBe(1);
    expect(runtime.loopStatus).toBe("EXECUTING_COMMAND");

    releaseCommand();
    await commandPromise;

    await waitFor(
      () => processedTurns.length === 1 && runtime.queueRuntime.length === 0,
    );

    expect(processedTurns).toEqual(["conv-a"]);
    expect(runtime.loopStatus).toBe("WAITING_ON_INPUT");
    expect(runtime.queuedMessagesByItemId.size).toBe(0);
  });

  test("mid-turn mode changes apply to same-turn approval classification", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.setActiveRuntime(listener);
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-mid",
    );
    const socket = new MockSocket();

    let releaseFirstDrain!: () => void;
    const firstDrainGate = new Promise<void>((resolve) => {
      releaseFirstDrain = resolve;
    });
    let drainCount = 0;
    drainHandlers.set("conv-mid", async () => {
      drainCount += 1;
      if (drainCount === 1) {
        await firstDrainGate;
        return {
          stopReason: "requires_approval",
          approvals: [
            {
              toolCallId: "tc-1",
              toolName: "Bash",
              toolArgs: '{"command":"pwd"}',
            },
          ],
          apiDurationMs: 0,
        };
      }
      return {
        stopReason: "end_turn",
        approvals: [],
        apiDurationMs: 0,
      };
    });

    let capturedModeAtClassification: string | null = null;
    (classifyApprovalsMock as any).mockImplementationOnce(
      async (_approvals: any, opts: any) => {
        capturedModeAtClassification = opts?.permissionModeState?.mode ?? null;
        return {
          autoAllowed: [
            {
              approval: {
                toolCallId: "tc-1",
                toolName: "Bash",
                toolArgs: '{"command":"pwd"}',
              },
              permission: { decision: "allow" },
              context: null,
              parsedArgs: { command: "pwd" },
            },
          ],
          autoDenied: [],
          needsUserInput: [],
        };
      },
    );
    (executeApprovalBatchMock as any).mockResolvedValueOnce([
      {
        type: "tool",
        tool_call_id: "tc-1",
        status: "success",
        tool_return: "ok",
      },
    ]);

    const turnPromise = __listenClientTestUtils.handleIncomingMessage(
      makeIncomingMessage("agent-1", "conv-mid", "run it"),
      socket as unknown as WebSocket,
      runtime,
    );

    await waitFor(() => sendMessageStreamMock.mock.calls.length >= 1);

    await __listenClientTestUtils.handleChangeDeviceStateInput(listener, {
      command: {
        type: "change_device_state",
        runtime: { agent_id: "agent-1", conversation_id: "conv-mid" },
        payload: { mode: "bypassPermissions" },
      },
      socket: socket as unknown as WebSocket,
      opts: {},
      processQueuedTurn: async () => {},
    });

    releaseFirstDrain();

    await turnPromise;

    expect(capturedModeAtClassification === "bypassPermissions").toBe(true);
  });

  test("change_device_state does not prune default-state entry mid-turn", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.setActiveRuntime(listener);
    const socket = new MockSocket();

    await __listenClientTestUtils.handleChangeDeviceStateInput(listener, {
      command: {
        type: "change_device_state",
        runtime: { agent_id: "agent-1", conversation_id: "default" },
        payload: { mode: "default" },
      },
      socket: socket as unknown as WebSocket,
      opts: {},
      processQueuedTurn: async () => {},
    });

    expect(
      listener.permissionModeByConversation.has(
        "agent:agent-1::conversation:default",
      ),
    ).toBe(true);
  });
});
