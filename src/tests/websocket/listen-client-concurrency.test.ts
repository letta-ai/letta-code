import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client/error";
import WebSocket from "ws";
import type { ResumeData } from "../../agent/check-approval";
import { permissionMode } from "../../permissions/mode";
import type {
  MessageQueueItem,
  TaskNotificationQueueItem,
} from "../../queue/queueRuntime";
import { sharedReminderProviders } from "../../reminders/engine";
import { queueSkillContent } from "../../tools/impl/skillContentRegistry";
import { clearTools, loadSpecificTools } from "../../tools/manager";
import { resolveRecoveredApprovalResponse } from "../../websocket/listener/recovery";
import { injectQueuedSkillContent } from "../../websocket/listener/skill-injection";
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

const sendMessageStreamCalls: Array<{
  conversationId: string;
  messages: unknown[];
  opts?: {
    agentId?: string;
    preparedToolContext?: {
      clientTools: Array<{ name: string }>;
      loadedToolNames: string[];
    };
  };
}> = [];
const sendMessageStreamMock = mock(
  async (
    conversationId: string,
    messages: unknown[],
    opts?: {
      agentId?: string;
      preparedToolContext?: {
        clientTools: Array<{ name: string }>;
        loadedToolNames: string[];
      };
    },
  ): Promise<MockStream> => {
    sendMessageStreamCalls.push({ conversationId, messages, opts });
    return {
      conversationId,
      agentId: opts?.agentId,
    };
  },
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
const agentModelById = new Map<string, string>();
const conversationModelById = new Map<string, string | null>();
const retrieveAgentMock = mock(async (agentId: string) => ({
  id: agentId,
  model: agentModelById.get(agentId) ?? "anthropic/claude-sonnet-4",
}));
const retrieveConversationMock = mock(async (conversationId: string) => ({
  id: conversationId,
  model: conversationModelById.get(conversationId) ?? null,
  in_context_message_ids: ["msg-recovered-approval"],
}));
const retrieveMessageMock = mock(async () => [
  {
    id: "msg-recovered-approval",
    message_type: "approval_request_message",
    tool_calls: [] as Array<{
      tool_call_id: string;
      name: string;
      arguments: string;
    }>,
  },
]);
const listAgentMessagesMock = mock(async () => ({
  getPaginatedItems: () => [],
}));
const cancelConversationMock = mock(async (_conversationId: string) => {});
const conversationMessagesStreamMock = mock(
  async (
    conversationId: string,
    _params?: {
      agent_id?: string;
      otid?: string;
      starting_after?: number;
      batch_size?: number;
    },
    _options?: {
      signal?: AbortSignal;
    },
  ): Promise<MockStream> => ({
    conversationId,
  }),
);
const getClientMock = mock(async () => ({
  agents: {
    retrieve: retrieveAgentMock,
    messages: {
      list: listAgentMessagesMock,
    },
  },
  conversations: {
    retrieve: retrieveConversationMock,
    cancel: cancelConversationMock,
    messages: {
      stream: conversationMessagesStreamMock,
    },
  },
  messages: {
    retrieve: retrieveMessageMock,
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

// Stub reminder providers that touch settingsManager/process.cwd so
// handleIncomingMessage works without a fully initialised environment.
// Uses the same save/restore pattern as listen-session-context.test.ts
// to avoid mock.module (which leaks into other test files in Bun).
const origSessionContext = sharedReminderProviders["session-context"];
const origAgentInfo = sharedReminderProviders["agent-info"];

describe("listen-client multi-worker concurrency", () => {
  beforeEach(() => {
    // No-op stubs for providers that need settingsManager / process.cwd
    sharedReminderProviders["session-context"] = async () => null;
    sharedReminderProviders["agent-info"] = async () => null;

    queueSkillContent("__test-cleanup__", "__test-cleanup__");
    injectQueuedSkillContent([]);
    agentModelById.clear();
    conversationModelById.clear();
    clearTools();
    permissionMode.reset();
    sendMessageStreamMock.mockClear();
    sendMessageStreamCalls.length = 0;
    getStreamToolContextIdMock.mockClear();
    drainStreamWithResumeMock.mockClear();
    getClientMock.mockClear();
    retrieveAgentMock.mockClear();
    retrieveConversationMock.mockClear();
    retrieveMessageMock.mockClear();
    listAgentMessagesMock.mockClear();
    getResumeDataMock.mockClear();
    classifyApprovalsMock.mockClear();
    executeApprovalBatchMock.mockClear();
    cancelConversationMock.mockClear();
    conversationMessagesStreamMock.mockClear();
    fetchRunErrorDetailMock.mockClear();
    drainHandlers.clear();
    __listenClientTestUtils.setActiveRuntime(null);
  });

  afterEach(() => {
    sharedReminderProviders["session-context"] = origSessionContext;
    sharedReminderProviders["agent-info"] = origAgentInfo;
    clearTools();
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
    expect(
      sendMessageStreamMock.mock.calls.map((call) => call[0]).sort(),
    ).toEqual(["conv-a", "conv-b"]);

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
    expect(sendMessageStreamMock.mock.calls.map((call) => call[0])).toEqual([
      "default",
      "default",
    ]);

    const agentACall = sendMessageStreamMock.mock.calls.find(
      (call) => call[2]?.agentId === "agent-a",
    );
    const agentBCall = sendMessageStreamMock.mock.calls.find(
      (call) => call[2]?.agentId === "agent-b",
    );

    expect(agentACall?.[2]).toMatchObject({
      agentId: "agent-a",
    });
    expect(agentBCall?.[2]).toMatchObject({
      agentId: "agent-b",
    });
  });

  test("prepares isolated tool snapshots for concurrent mixed-provider turns", async () => {
    await loadSpecificTools(["Edit"]);
    agentModelById.set("agent-openai", "openai/gpt-5.3-codex");
    agentModelById.set("agent-anthropic", "anthropic/claude-sonnet-4");

    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtimeOpenAI =
      __listenClientTestUtils.getOrCreateConversationRuntime(
        listener,
        "agent-openai",
        "conv-openai",
      );
    const runtimeAnthropic =
      __listenClientTestUtils.getOrCreateConversationRuntime(
        listener,
        "agent-anthropic",
        "conv-anthropic",
      );
    const socket = new MockSocket();
    const drainOpenAI = createDeferredDrain();
    const drainAnthropic = createDeferredDrain();
    drainHandlers.set("conv-openai", () => drainOpenAI.promise);
    drainHandlers.set("conv-anthropic", () => drainAnthropic.promise);

    const openAITurn = __listenClientTestUtils.handleIncomingMessage(
      makeIncomingMessage("agent-openai", "conv-openai", "codex turn"),
      socket as unknown as WebSocket,
      runtimeOpenAI,
    );
    const anthropicTurn = __listenClientTestUtils.handleIncomingMessage(
      makeIncomingMessage(
        "agent-anthropic",
        "conv-anthropic",
        "anthropic turn",
      ),
      socket as unknown as WebSocket,
      runtimeAnthropic,
    );

    await waitFor(() => sendMessageStreamCalls.length === 2);

    const openAICall = sendMessageStreamCalls.find(
      (call) => call.conversationId === "conv-openai",
    );
    const anthropicCall = sendMessageStreamCalls.find(
      (call) => call.conversationId === "conv-anthropic",
    );

    const openAITools =
      openAICall?.opts?.preparedToolContext?.clientTools.map(
        (tool) => tool.name,
      ) ?? [];
    const anthropicTools =
      anthropicCall?.opts?.preparedToolContext?.clientTools.map(
        (tool) => tool.name,
      ) ?? [];

    expect(openAITools).toContain("ApplyPatch");
    expect(openAITools).not.toContain("Edit");
    expect(anthropicTools).toContain("Edit");
    expect(anthropicTools).not.toContain("ApplyPatch");
    expect(openAICall?.opts?.preparedToolContext?.loadedToolNames).toContain(
      "ApplyPatch",
    );
    expect(anthropicCall?.opts?.preparedToolContext?.loadedToolNames).toContain(
      "Edit",
    );
    expect(runtimeOpenAI.currentLoadedTools).toContain("ApplyPatch");
    expect(runtimeAnthropic.currentLoadedTools).toContain("Edit");

    drainOpenAI.resolve(defaultDrainResult);
    drainAnthropic.resolve(defaultDrainResult);
    await Promise.all([openAITurn, anthropicTurn]);
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
            approvalContext: null,
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
    ).toEqual([messageItem.id]);
    expect(consumed?.queuedTurn.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "queued user" }],
      },
    ]);
    expect(runtime.queueRuntime.length).toBe(2);
    expect(runtime.queuedMessagesByItemId.has(otherMessageItem.id)).toBe(true);
    expect(runtime.queueRuntime.peek().map((item) => item.id)).toEqual([
      taskItem.id,
      otherMessageItem.id,
    ]);
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
    // biome-ignore lint/suspicious/noExplicitAny: mock method access
    (classifyApprovalsMock as any).mockResolvedValueOnce({
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

    queueSkillContent(
      "tool-call-1",
      "<searching-messages>stale recovery skill content</searching-messages>",
    );

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
    expect(continuationMessages).toHaveLength(3);
    expect(continuationMessages?.[0]).toEqual(
      expect.objectContaining({
        type: "approval",
        approvals: [approvalResult],
        otid: expect.any(String),
      }),
    );
    expect(continuationMessages?.[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "queued user" }],
    });
    expect(continuationMessages?.[2]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "<searching-messages>stale recovery skill content</searching-messages>",
        },
      ],
      otid: expect.any(String),
    });
    expect(runtime.loopStatus as string).toBe("PROCESSING_API_RESPONSE");
    expect(runtime.queueRuntime.length).toBe(1);
    expect(runtime.queueRuntime.peek()[0]?.kind).toBe("task_notification");
    expect(runtime.queuedMessagesByItemId.size).toBe(0);
    expect(
      socket.sentPayloads.some((payload) => payload.includes("queued user")),
    ).toBe(true);
    expect(
      socket.sentPayloads.some((payload) =>
        payload.includes("<task-notification>done</task-notification>"),
      ),
    ).toBe(false);

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

  test("interrupt-queue approval continuation appends skill content as trailing user message", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.setActiveRuntime(listener);
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-int",
    );
    const socket = new MockSocket();

    runtime.pendingInterruptedResults = [
      {
        type: "approval",
        tool_call_id: "call-int",
        approve: false,
        reason: "Interrupted by user",
      },
    ] as never;
    runtime.pendingInterruptedContext = {
      agentId: "agent-1",
      conversationId: "conv-int",
      continuationEpoch: runtime.continuationEpoch,
    };
    runtime.pendingInterruptedToolCallIds = ["call-int"];

    queueSkillContent(
      "call-int",
      "<searching-messages>interrupt path skill content</searching-messages>",
    );

    await __listenClientTestUtils.handleIncomingMessage(
      {
        type: "message",
        agentId: "agent-1",
        conversationId: "conv-int",
        messages: [],
      } as unknown as IncomingMessage,
      socket as unknown as WebSocket,
      runtime,
    );

    expect(sendMessageStreamMock.mock.calls.length).toBeGreaterThan(0);
    const firstSendMessages = sendMessageStreamMock.mock.calls[0]?.[1] as
      | Array<Record<string, unknown>>
      | undefined;

    expect(firstSendMessages).toHaveLength(2);
    expect(firstSendMessages?.[0]).toMatchObject({
      type: "approval",
      approvals: [
        {
          tool_call_id: "call-int",
          approve: false,
          reason: "Interrupted by user",
        },
      ],
    });
    expect(firstSendMessages?.[1]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "<searching-messages>interrupt path skill content</searching-messages>",
        },
      ],
      otid: expect.any(String),
    });
  });

  test("recovered approval replay keeps approval-only routing and appends skill content at send boundary", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.setActiveRuntime(listener);
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-recovered",
    );
    const socket = new MockSocket();

    runtime.recoveredApprovalState = {
      agentId: "agent-1",
      conversationId: "conv-recovered",
      approvalsByRequestId: new Map([
        [
          "perm-recovered-1",
          {
            approval: {
              toolCallId: "tool-call-recovered-1",
              toolName: "Write",
              toolArgs: '{"file_path":"foo.ts"}',
            },
            approvalContext: null,
            controlRequest: {
              type: "control_request",
              request_id: "perm-recovered-1",
              request: {
                subtype: "can_use_tool",
                tool_name: "Write",
                input: { file_path: "foo.ts" },
                tool_call_id: "tool-call-recovered-1",
                permission_suggestions: [],
                blocked_path: null,
              },
              agent_id: "agent-1",
              conversation_id: "conv-recovered",
            },
          },
        ],
      ]),
      pendingRequestIds: new Set(["perm-recovered-1"]),
      responsesByRequestId: new Map(),
    };

    queueSkillContent(
      "tool-call-recovered-1",
      "<searching-messages>recovered skill content</searching-messages>",
    );

    await resolveRecoveredApprovalResponse(
      runtime,
      socket as unknown as WebSocket,
      {
        request_id: "perm-recovered-1",
        decision: { behavior: "allow" },
      },
      __listenClientTestUtils.handleIncomingMessage,
      {},
    );

    expect(sendMessageStreamMock.mock.calls.length).toBeGreaterThan(0);
    const firstSendMessages = sendMessageStreamMock.mock.calls[0]?.[1] as
      | Array<Record<string, unknown>>
      | undefined;

    expect(firstSendMessages).toHaveLength(2);
    expect(firstSendMessages?.[0]).toMatchObject({
      type: "approval",
      approvals: [],
    });
    expect(firstSendMessages?.[1]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "<searching-messages>recovered skill content</searching-messages>",
        },
      ],
      otid: expect.any(String),
    });
  });

  test("sync replay preserves hidden auto decisions while only surfacing manual recovered approvals", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.setActiveRuntime(listener);
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-mixed-sync",
    );

    const autoAllowedApproval = {
      toolCallId: "tool-auto-allow",
      toolName: "Read",
      toolArgs: '{"file_path":"foo.ts"}',
    };
    const manualApproval = {
      toolCallId: "tool-manual",
      toolName: "Bash",
      toolArgs: '{"command":"rm -rf tmp"}',
    };
    const autoDeniedApproval = {
      toolCallId: "tool-auto-deny",
      toolName: "Write",
      toolArgs: '{"file_path":"denied.ts","content":"nope"}',
    };

    retrieveConversationMock.mockResolvedValueOnce({
      id: "conv-mixed-sync",
      model: null,
      in_context_message_ids: ["msg-recovered-approval"],
    });
    retrieveMessageMock.mockResolvedValueOnce([
      {
        id: "msg-recovered-approval",
        message_type: "approval_request_message",
        tool_calls: [
          {
            tool_call_id: autoAllowedApproval.toolCallId,
            name: autoAllowedApproval.toolName,
            arguments: autoAllowedApproval.toolArgs,
          },
          {
            tool_call_id: manualApproval.toolCallId,
            name: manualApproval.toolName,
            arguments: manualApproval.toolArgs,
          },
          {
            tool_call_id: autoDeniedApproval.toolCallId,
            name: autoDeniedApproval.toolName,
            arguments: autoDeniedApproval.toolArgs,
          },
        ],
      },
    ]);
    // biome-ignore lint/suspicious/noExplicitAny: mock method access
    (classifyApprovalsMock as any).mockResolvedValueOnce({
      autoAllowed: [
        {
          approval: autoAllowedApproval,
          parsedArgs: { file_path: "foo.ts" },
          permission: { decision: "allow", reason: "auto" },
        },
      ],
      autoDenied: [
        {
          approval: autoDeniedApproval,
          parsedArgs: { file_path: "denied.ts", content: "nope" },
          permission: { decision: "deny", reason: "blocked" },
          denyReason: "blocked by policy",
        },
      ],
      needsUserInput: [
        {
          approval: manualApproval,
          parsedArgs: { command: "rm -rf tmp" },
          permission: { decision: "ask", reason: "needs approval" },
          context: {
            recommendedRule: "Bash(rm:*)",
            ruleDescription: "rm commands",
            approveAlwaysText:
              "Yes, and don't ask again for 'rm' commands in this project",
            defaultScope: "project",
            allowPersistence: true,
            safetyLevel: "moderate",
          },
        },
      ],
    } as never);

    await __listenClientTestUtils.recoverApprovalStateForSync(runtime, {
      agent_id: "agent-1",
      conversation_id: "conv-mixed-sync",
    });

    expect(runtime.recoveredApprovalState?.pendingRequestIds).toEqual(
      new Set(["perm-tool-manual"]),
    );
    expect(runtime.recoveredApprovalState?.autoDecisions).toEqual([
      {
        type: "approve",
        approval: autoAllowedApproval,
      },
      {
        type: "deny",
        approval: autoDeniedApproval,
        reason: "blocked by policy",
      },
    ]);
    expect(runtime.recoveredApprovalState?.allApprovals).toEqual([
      autoAllowedApproval,
      manualApproval,
      autoDeniedApproval,
    ]);

    const deviceStatus = __listenClientTestUtils.buildDeviceStatus(listener, {
      agent_id: "agent-1",
      conversation_id: "conv-mixed-sync",
    });
    expect(deviceStatus.pending_control_requests).toEqual([
      {
        request_id: "perm-tool-manual",
        request: expect.objectContaining({
          subtype: "can_use_tool",
          tool_name: "Bash",
          tool_call_id: "tool-manual",
          permission_suggestions: [
            {
              id: "save-default",
              text: "Yes, and don't ask again for 'rm' commands in this project",
            },
          ],
        }),
      },
    ]);
  });

  test("recovered approval continuation executes hidden auto decisions together with manual responses", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.setActiveRuntime(listener);
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-mixed-recovered",
    );
    const socket = new MockSocket();

    const autoAllowedApproval = {
      toolCallId: "tool-auto-allow",
      toolName: "Read",
      toolArgs: '{"file_path":"foo.ts"}',
    };
    const manualApproval = {
      toolCallId: "tool-manual",
      toolName: "Bash",
      toolArgs: '{"command":"rm -rf tmp"}',
    };
    const autoDeniedApproval = {
      toolCallId: "tool-auto-deny",
      toolName: "Write",
      toolArgs: '{"file_path":"denied.ts","content":"nope"}',
    };
    const approvalResults = [
      {
        type: "tool",
        tool_call_id: "tool-auto-allow",
        tool_return: "auto ok",
        status: "success",
      },
      {
        type: "approval",
        tool_call_id: "tool-auto-deny",
        approve: false,
        reason: "blocked by policy",
      },
      {
        type: "tool",
        tool_call_id: "tool-manual",
        tool_return: "manual ok",
        status: "success",
      },
    ];
    executeApprovalBatchMock.mockResolvedValueOnce(approvalResults as never);

    runtime.recoveredApprovalState = {
      agentId: "agent-1",
      conversationId: "conv-mixed-recovered",
      approvalsByRequestId: new Map([
        [
          "perm-tool-manual",
          {
            approval: manualApproval,
            approvalContext: null,
            controlRequest: {
              type: "control_request",
              request_id: "perm-tool-manual",
              request: {
                subtype: "can_use_tool",
                tool_name: "Bash",
                input: { command: "rm -rf tmp" },
                tool_call_id: "tool-manual",
                permission_suggestions: [],
                blocked_path: null,
              },
              agent_id: "agent-1",
              conversation_id: "conv-mixed-recovered",
            },
          },
        ],
      ]),
      pendingRequestIds: new Set(["perm-tool-manual"]),
      responsesByRequestId: new Map(),
      autoDecisions: [
        {
          type: "approve",
          approval: autoAllowedApproval,
        },
        {
          type: "deny",
          approval: autoDeniedApproval,
          reason: "blocked by policy",
        },
      ],
      allApprovals: [autoAllowedApproval, manualApproval, autoDeniedApproval],
    };

    const handled = await resolveRecoveredApprovalResponse(
      runtime,
      socket as unknown as WebSocket,
      {
        request_id: "perm-tool-manual",
        decision: { behavior: "allow", message: "approved manually" },
      },
      __listenClientTestUtils.handleIncomingMessage,
      {},
    );

    expect(handled).toBe(true);
    expect(executeApprovalBatchMock).toHaveBeenCalledWith(
      [
        {
          type: "approve",
          approval: autoAllowedApproval,
        },
        {
          type: "deny",
          approval: autoDeniedApproval,
          reason: "blocked by policy",
        },
        {
          type: "approve",
          approval: manualApproval,
          reason: "approved manually",
        },
      ],
      undefined,
      expect.any(Object),
    );

    const continuationMessages = sendMessageStreamMock.mock.calls[0]?.[1] as
      | Array<Record<string, unknown>>
      | undefined;
    expect(continuationMessages?.[0]).toEqual(
      expect.objectContaining({
        type: "approval",
        approvals: approvalResults,
      }),
    );
  });

  test("sync replay suppresses recovered approvals when interrupted cache is active", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.setActiveRuntime(listener);
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-sync",
    );

    runtime.pendingInterruptedResults = [
      {
        type: "approval",
        tool_call_id: "call-sync",
        approve: false,
        reason: "User interrupted the stream",
      },
    ] as never;
    runtime.pendingInterruptedContext = {
      agentId: "agent-1",
      conversationId: "conv-sync",
      continuationEpoch: runtime.continuationEpoch,
    };
    runtime.pendingInterruptedToolCallIds = null;
    runtime.recoveredApprovalState = {
      agentId: "agent-1",
      conversationId: "conv-sync",
      approvalsByRequestId: new Map([
        [
          "perm-sync",
          {
            approval: {
              toolCallId: "call-sync",
              toolName: "Bash",
              toolArgs: '{"command":"sleep 300"}',
            },
            approvalContext: null,
            controlRequest: {
              type: "control_request",
              request_id: "perm-sync",
              request: {
                subtype: "can_use_tool",
                tool_name: "Bash",
                input: { command: "sleep 300" },
                tool_call_id: "call-sync",
                permission_suggestions: [],
                blocked_path: null,
              },
              agent_id: "agent-1",
              conversation_id: "conv-sync",
            },
          },
        ],
      ]),
      pendingRequestIds: new Set(["perm-sync"]),
      responsesByRequestId: new Map(),
    };
    runtime.loopStatus = "WAITING_ON_APPROVAL";
    getResumeDataMock.mockClear();
    retrieveAgentMock.mockClear();

    await __listenClientTestUtils.recoverApprovalStateForSync(runtime, {
      agent_id: "agent-1",
      conversation_id: "conv-sync",
    });

    expect(retrieveAgentMock).not.toHaveBeenCalled();
    expect(getResumeDataMock).not.toHaveBeenCalled();
    expect(runtime.recoveredApprovalState).toBeNull();

    const deviceStatus = __listenClientTestUtils.buildDeviceStatus(listener, {
      agent_id: "agent-1",
      conversation_id: "conv-sync",
    });
    const loopStatus = __listenClientTestUtils.buildLoopStatus(listener, {
      agent_id: "agent-1",
      conversation_id: "conv-sync",
    });

    expect(deviceStatus.pending_control_requests).toEqual([]);
    expect(loopStatus.status).toBe("WAITING_ON_INPUT");
    expect(loopStatus.active_run_ids).toEqual([]);
  });

  test("recovered approval response does not revive an interrupted turn", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.setActiveRuntime(listener);
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-stale",
    );
    const socket = new MockSocket();

    runtime.pendingInterruptedResults = [
      {
        type: "approval",
        tool_call_id: "tool-call-stale",
        approve: false,
        reason: "User interrupted the stream",
      },
    ] as never;
    runtime.pendingInterruptedContext = {
      agentId: "agent-1",
      conversationId: "conv-stale",
      continuationEpoch: runtime.continuationEpoch,
    };
    runtime.pendingInterruptedToolCallIds = null;
    runtime.recoveredApprovalState = {
      agentId: "agent-1",
      conversationId: "conv-stale",
      approvalsByRequestId: new Map([
        [
          "perm-stale",
          {
            approval: {
              toolCallId: "tool-call-stale",
              toolName: "Bash",
              toolArgs: '{"command":"sleep 300"}',
            },
            approvalContext: null,
            controlRequest: {
              type: "control_request",
              request_id: "perm-stale",
              request: {
                subtype: "can_use_tool",
                tool_name: "Bash",
                input: { command: "sleep 300" },
                tool_call_id: "tool-call-stale",
                permission_suggestions: [],
                blocked_path: null,
              },
              agent_id: "agent-1",
              conversation_id: "conv-stale",
            },
          },
        ],
      ]),
      pendingRequestIds: new Set(["perm-stale"]),
      responsesByRequestId: new Map(),
    };

    const handled = await resolveRecoveredApprovalResponse(
      runtime,
      socket as unknown as WebSocket,
      {
        request_id: "perm-stale",
        decision: { behavior: "deny", message: "Denied after interrupt" },
      },
      __listenClientTestUtils.handleIncomingMessage,
      {},
    );

    expect(handled).toBe(true);
    expect(runtime.recoveredApprovalState).toBeNull();
    expect(sendMessageStreamMock).not.toHaveBeenCalled();
    expect(runtime.isProcessing).toBe(false);
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
    // biome-ignore lint/suspicious/noExplicitAny: mock method access
    (classifyApprovalsMock as any).mockImplementationOnce(
      // biome-ignore lint/suspicious/noExplicitAny: mock param types
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
    // biome-ignore lint/suspicious/noExplicitAny: mock method access
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

  test("pre-stream 409 resumes via conversations stream with message otid", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-409-otid",
      "conv-409-otid",
    );
    const socket = new MockSocket();

    sendMessageStreamMock.mockRejectedValueOnce(
      new APIError(
        409,
        {
          error: {
            detail:
              "Cannot send a new message: Another request is currently being processed for this conversation.",
          },
        },
        undefined,
        new Headers(),
      ),
    );

    const turnPromise = __listenClientTestUtils.handleIncomingMessage(
      {
        type: "message",
        agentId: "agent-409-otid",
        conversationId: "conv-409-otid",
        messages: [
          {
            role: "user",
            content: "hello",
            otid: "otid-123",
          } as unknown as IncomingMessage["messages"][number],
        ],
      },
      socket as unknown as WebSocket,
      runtime,
    );

    await waitFor(() => conversationMessagesStreamMock.mock.calls.length === 1);

    const [, resumeParams] = conversationMessagesStreamMock.mock.calls[0] ?? [];
    expect(resumeParams).toMatchObject({
      agent_id: undefined,
      otid: "otid-123",
      starting_after: 0,
      batch_size: 1000,
    });

    await turnPromise;
  });

  test("pre-stream 409 resume on default conversation includes agent_id", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-409-default",
      "default",
    );
    const socket = new MockSocket();

    sendMessageStreamMock.mockRejectedValueOnce(
      new APIError(
        409,
        {
          error: {
            detail:
              "Cannot send a new message: Another request is currently being processed for this conversation.",
          },
        },
        undefined,
        new Headers(),
      ),
    );

    const turnPromise = __listenClientTestUtils.handleIncomingMessage(
      {
        type: "message",
        agentId: "agent-409-default",
        conversationId: "default",
        messages: [
          {
            role: "user",
            content: "hello default",
            otid: "otid-default",
          } as unknown as IncomingMessage["messages"][number],
        ],
      },
      socket as unknown as WebSocket,
      runtime,
    );

    await waitFor(() => conversationMessagesStreamMock.mock.calls.length === 1);

    const [resumeConversationId, resumeParams] =
      conversationMessagesStreamMock.mock.calls[0] ?? [];
    expect(resumeConversationId).toBe("default");
    expect(resumeParams).toMatchObject({
      agent_id: "agent-409-default",
      otid: "otid-default",
      starting_after: 0,
      batch_size: 1000,
    });

    await turnPromise;
  });

  test("approval continuation 409 resumes via conversations stream with approval otid", async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-409-approval",
      "conv-409-approval",
    );
    const socket = new MockSocket();

    // biome-ignore lint/suspicious/noExplicitAny: mock method access
    (classifyApprovalsMock as any).mockResolvedValueOnce({
      autoAllowed: [
        {
          approval: {
            toolCallId: "tool-1",
            toolName: "Read",
            toolArgs: "{}",
          },
          parsedArgs: {},
          permission: { allowed: true, reason: "auto" },
          denyReason: null,
        },
      ],
      autoDenied: [],
      needsUserInput: [],
    });

    executeApprovalBatchMock.mockResolvedValueOnce([
      {
        type: "tool",
        toolCallId: "tool-1",
        toolName: "Read",
        toolArgs: "{}",
        result: "ok",
        approved: true,
      },
    ] as never);

    sendMessageStreamMock.mockRejectedValueOnce(
      new APIError(
        409,
        {
          error: {
            detail:
              "Cannot send a new message: Another request is currently being processed for this conversation.",
          },
        },
        undefined,
        new Headers(),
      ),
    );

    getResumeDataMock.mockResolvedValueOnce({
      pendingApproval: {
        toolCallId: "tool-1",
        toolName: "Read",
        toolArgs: "{}",
      },
      pendingApprovals: [
        {
          toolCallId: "tool-1",
          toolName: "Read",
          toolArgs: "{}",
        },
      ],
      messageHistory: [],
    });

    const parentAbortController = new AbortController();

    const result = await __listenClientTestUtils.resolveStaleApprovals(
      runtime,
      socket as unknown as WebSocket,
      parentAbortController.signal,
      {
        getResumeData: getResumeDataMock,
      },
    );

    expect(result?.stopReason).toBe("end_turn");
    await waitFor(() => conversationMessagesStreamMock.mock.calls.length >= 1);

    const firstCall = conversationMessagesStreamMock.mock.calls[0];
    expect(firstCall?.[0]).toBe("conv-409-approval");
    expect(firstCall?.[1]).toMatchObject({
      otid: expect.any(String),
      starting_after: 0,
      batch_size: 1000,
    });
    expect(firstCall?.[2]).toMatchObject({
      signal: expect.any(AbortSignal),
    });
    expect(firstCall?.[2]?.signal).not.toBe(parentAbortController.signal);
  });
});
