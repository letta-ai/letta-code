import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { permissionMode } from "@/permissions/mode";
import { sharedReminderProviders } from "@/reminders/engine";
import { settingsManager } from "@/settings-manager";
import { clearTools } from "@/tools/manager";
import type { ConversationRuntime } from "@/websocket/listener/types";

/**
 * A listener turn spans multiple HTTP requests (one per client-side tool
 * round-trip) while the server re-resolves the effective model per request.
 * These tests pin the turn-scoped model snapshot behavior: every request of
 * a turn carries the turn-start resolved model via override_model, provider
 * fallback still wins, and a live mid-turn /model switch still takes effect.
 */

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
    overrideModel?: string;
  };
}> = [];
const sendMessageStreamMock = mock(
  async (
    conversationId: string,
    messages: unknown[],
    opts?: {
      agentId?: string;
      overrideModel?: string;
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

type MockAgentRecord = {
  id: string;
  model: string;
  llm_config?: Record<string, unknown>;
};
const agentsById = new Map<string, MockAgentRecord>();
const conversationModelById = new Map<string, string | null>();
const retrieveAgentMock = mock(async (agentId: string) => {
  const record = agentsById.get(agentId);
  return {
    id: agentId,
    model: record?.model ?? "anthropic/claude-sonnet-4",
    ...(record?.llm_config ? { llm_config: record.llm_config } : {}),
  };
});
const retrieveConversationMock = mock(async (conversationId: string) => ({
  id: conversationId,
  model: conversationModelById.get(conversationId) ?? null,
  in_context_message_ids: [],
}));
const listAgentMessagesMock = mock(async () => ({
  getPaginatedItems: () => [],
}));
const cancelConversationMock = mock(async (_conversationId: string) => {});
const retrieveRunMock = mock(async (runId: string) => ({
  id: runId,
  status: "completed",
}));
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
  },
  runs: {
    retrieve: retrieveRunMock,
  },
}));
const classifyApprovalsMock = mock(async () => ({
  autoAllowed: [],
  autoDenied: [],
  needsUserInput: [],
}));
const executeApprovalBatchMock = mock(async () => []);

const realStreamModule = await import("@/cli/helpers/stream");
const realDrainStreamWithResume = realStreamModule.drainStreamWithResume;
const realAgentMessageModule = await import("@/agent/message");
const realSendMessageStream = realAgentMessageModule.sendMessageStream;
const realGetStreamToolContextId =
  realAgentMessageModule.getStreamToolContextId;
// Capture real implementations BEFORE applying `mock.module(...)` so they can
// be restored in afterAll: `mock.restore()` does NOT undo `mock.module()`
// swaps, and module identity is process-global.
const realApprovalClassificationModule = await import(
  "@/cli/helpers/approval-classification"
);
const realClassifyApprovals =
  realApprovalClassificationModule.classifyApprovals;
const realApprovalExecutionModule = await import("@/agent/approval-execution");
const realExecuteApprovalBatch =
  realApprovalExecutionModule.executeApprovalBatch;

mock.module("../agent/message", () => ({
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

mock.module("../cli/helpers/stream", () => ({
  ...realStreamModule,
  drainStreamWithResume: drainStreamWithResumeMock,
}));

mock.module("../backend/api/client", () => ({
  getClient: getClientMock,
  getServerUrl: () => "https://example.test",
  clearLastSDKDiagnostic: () => {},
  consumeLastSDKDiagnostic: () => null,
}));

mock.module("../cli/helpers/approval-classification", () => ({
  classifyApprovals: classifyApprovalsMock,
}));

mock.module("../agent/approval-execution", () => ({
  executeApprovalBatch: executeApprovalBatchMock,
}));

const listenClientModule = await import("@/websocket/listen-client");
const { __listenClientTestUtils } = listenClientModule;

class MockSocket {
  readyState: number = WebSocket.OPEN;
  sentPayloads: string[] = [];

  send(data: string): void {
    this.sentPayloads.push(data);
  }

  close(): void {}

  removeAllListeners(): this {
    return this;
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

function createRuntime(agentId: string, conversationId: string) {
  const listener = __listenClientTestUtils.createListenerRuntime();
  return {
    listener,
    runtime: __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      agentId,
      conversationId,
    ) as ConversationRuntime,
  };
}

function stubApprovalRoundTrip(toolCallId: string) {
  // biome-ignore lint/suspicious/noExplicitAny: mock method access
  (classifyApprovalsMock as any).mockImplementationOnce(async () => ({
    autoAllowed: [
      {
        approval: {
          toolCallId,
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
  }));
  // biome-ignore lint/suspicious/noExplicitAny: mock method access
  (executeApprovalBatchMock as any).mockResolvedValueOnce([
    {
      type: "tool",
      tool_call_id: toolCallId,
      status: "success",
      tool_return: "ok",
    },
  ]);
}

function requiresApprovalDrain(toolCallId: string): DrainResult {
  return {
    stopReason: "requires_approval",
    approvals: [
      {
        toolCallId,
        toolName: "Bash",
        toolArgs: '{"command":"pwd"}',
      },
    ],
    apiDurationMs: 0,
  };
}

// Stub reminder providers that touch settingsManager/process.cwd so
// handleIncomingMessage works without a fully initialised environment.
const origSessionContext = sharedReminderProviders["session-context"];
const origAgentInfo = sharedReminderProviders["agent-info"];
const originalGetLocalProjectSettings = settingsManager.getLocalProjectSettings;
const originalGetSettings = settingsManager.getSettings;
const originalTranscriptRoot = process.env.LETTA_TRANSCRIPT_ROOT;
let testTranscriptRoot: string | null = null;

describe("listener turn-scoped model pinning", () => {
  beforeEach(async () => {
    testTranscriptRoot = await mkdtemp(join(tmpdir(), "letta-turn-pin-"));
    process.env.LETTA_TRANSCRIPT_ROOT = testTranscriptRoot;

    sharedReminderProviders["session-context"] = async () => null;
    sharedReminderProviders["agent-info"] = async () => null;
    (settingsManager as typeof settingsManager).getSettings = (() =>
      ({
        memoryReminderInterval: null,
      }) as ReturnType<
        typeof settingsManager.getSettings
      >) as typeof settingsManager.getSettings;
    (settingsManager as typeof settingsManager).getLocalProjectSettings = () =>
      ({}) as ReturnType<typeof settingsManager.getLocalProjectSettings>;

    agentsById.clear();
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
    classifyApprovalsMock.mockClear();
    executeApprovalBatchMock.mockClear();
    drainHandlers.clear();
    __listenClientTestUtils.setActiveRuntime(null);
  });

  afterEach(async () => {
    sharedReminderProviders["session-context"] = origSessionContext;
    sharedReminderProviders["agent-info"] = origAgentInfo;
    (settingsManager as typeof settingsManager).getSettings =
      originalGetSettings;
    (settingsManager as typeof settingsManager).getLocalProjectSettings =
      originalGetLocalProjectSettings;
    clearTools();
    permissionMode.reset();
    __listenClientTestUtils.setActiveRuntime(null);
    if (originalTranscriptRoot === undefined) {
      delete process.env.LETTA_TRANSCRIPT_ROOT;
    } else {
      process.env.LETTA_TRANSCRIPT_ROOT = originalTranscriptRoot;
    }
    if (testTranscriptRoot) {
      await rm(testTranscriptRoot, { recursive: true, force: true });
      testTranscriptRoot = null;
    }
  });

  afterAll(() => {
    // `mock.module()` swaps are process-global: restore the captured real
    // implementations so other test files see the real modules.
    classifyApprovalsMock.mockReset();
    // biome-ignore lint/suspicious/noExplicitAny: real implementations have wider signatures than the narrow zero-arg mocks
    (classifyApprovalsMock as any).mockImplementation(realClassifyApprovals);
    executeApprovalBatchMock.mockReset();
    // biome-ignore lint/suspicious/noExplicitAny: see above
    (executeApprovalBatchMock as any).mockImplementation(
      realExecuteApprovalBatch,
    );
    sendMessageStreamMock.mockReset();
    // biome-ignore lint/suspicious/noExplicitAny: see above
    (sendMessageStreamMock as any).mockImplementation(realSendMessageStream);
    getStreamToolContextIdMock.mockReset();
    // biome-ignore lint/suspicious/noExplicitAny: see above
    (getStreamToolContextIdMock as any).mockImplementation(
      realGetStreamToolContextId,
    );
    drainStreamWithResumeMock.mockReset();
    // biome-ignore lint/suspicious/noExplicitAny: see above
    (drainStreamWithResumeMock as any).mockImplementation(
      realDrainStreamWithResume,
    );
    mock.restore();
  });

  test("pins the turn-start model on every request even when the agent model changes mid-turn", async () => {
    agentsById.set("agent-pin", {
      id: "agent-pin",
      model: "anthropic/claude-sonnet-4-5",
    });
    const { runtime } = createRuntime("agent-pin", "conv-pin");
    const socket = new MockSocket();

    let drainCount = 0;
    drainHandlers.set("conv-pin", async () => {
      drainCount += 1;
      if (drainCount === 1) {
        // Simulate an external agent PATCH landing between tool calls.
        agentsById.set("agent-pin", {
          id: "agent-pin",
          model: "openai/gpt-5.4",
        });
        return requiresApprovalDrain("tc-pin-1");
      }
      return defaultDrainResult;
    });
    stubApprovalRoundTrip("tc-pin-1");

    await __listenClientTestUtils.handleIncomingMessage(
      makeIncomingMessage("agent-pin", "conv-pin", "run it"),
      socket as unknown as WebSocket,
      runtime,
    );

    expect(sendMessageStreamCalls.length).toBe(2);
    expect(sendMessageStreamCalls[0]?.opts?.overrideModel).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    // The approval continuation is a separate HTTP request; without the pin
    // the server would re-resolve the (patched) agent model here.
    expect(sendMessageStreamCalls[1]?.opts?.overrideModel).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    expect(
      (sendMessageStreamCalls[1]?.messages?.[0] as { type?: string }).type,
    ).toBe("approval");
  });

  test("pins the conversation-level model override when present", async () => {
    agentsById.set("agent-conv", {
      id: "agent-conv",
      model: "anthropic/claude-sonnet-4-5",
    });
    conversationModelById.set("conv-override", "openai/gpt-5.4");
    const { runtime } = createRuntime("agent-conv", "conv-override");
    const socket = new MockSocket();

    let drainCount = 0;
    drainHandlers.set("conv-override", async () => {
      drainCount += 1;
      if (drainCount === 1) {
        return requiresApprovalDrain("tc-conv-1");
      }
      return defaultDrainResult;
    });
    stubApprovalRoundTrip("tc-conv-1");

    await __listenClientTestUtils.handleIncomingMessage(
      makeIncomingMessage("agent-conv", "conv-override", "run it"),
      socket as unknown as WebSocket,
      runtime,
    );

    expect(sendMessageStreamCalls.length).toBe(2);
    // The snapshot IS the resolved conversation-override → agent-fallback
    // value, so the conversation override wins over the agent model.
    expect(sendMessageStreamCalls[0]?.opts?.overrideModel).toBe(
      "openai/gpt-5.4",
    );
    expect(sendMessageStreamCalls[1]?.opts?.overrideModel).toBe(
      "openai/gpt-5.4",
    );
  });

  test("live mid-turn /model switch beats the turn-start snapshot and resets on the next turn", async () => {
    agentsById.set("agent-live", {
      id: "agent-live",
      model: "anthropic/claude-sonnet-4-5",
    });
    const { runtime } = createRuntime("agent-live", "conv-live");
    const socket = new MockSocket();

    let drainCount = 0;
    drainHandlers.set("conv-live", async () => {
      drainCount += 1;
      if (drainCount === 1) {
        // Simulate applyModelUpdateForRuntime landing mid-turn.
        runtime.liveModelSwitchHandle = "zai/glm-4.6";
        return requiresApprovalDrain("tc-live-1");
      }
      return defaultDrainResult;
    });
    stubApprovalRoundTrip("tc-live-1");

    await __listenClientTestUtils.handleIncomingMessage(
      makeIncomingMessage("agent-live", "conv-live", "run it"),
      socket as unknown as WebSocket,
      runtime,
    );

    expect(sendMessageStreamCalls.length).toBe(2);
    expect(sendMessageStreamCalls[0]?.opts?.overrideModel).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    // The deliberate user switch must win over the turn-start snapshot.
    expect(sendMessageStreamCalls[1]?.opts?.overrideModel).toBe("zai/glm-4.6");

    // A new turn re-resolves from agent/conversation config: the recorded
    // live switch must not leak into the next turn's requests.
    await __listenClientTestUtils.handleIncomingMessage(
      makeIncomingMessage("agent-live", "conv-live", "again"),
      socket as unknown as WebSocket,
      runtime,
    );
    expect(sendMessageStreamCalls.length).toBe(3);
    expect(sendMessageStreamCalls[2]?.opts?.overrideModel).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    expect(runtime.liveModelSwitchHandle).toBeNull();
  });

  test("provider fallback still overrides the turn-start snapshot", async () => {
    agentsById.set("agent-fallback", {
      id: "agent-fallback",
      model: "anthropic/claude-sonnet-5",
      llm_config: {
        context_window: 200000,
        model: "anthropic/claude-sonnet-5",
        model_endpoint_type: "anthropic",
        reasoning_effort: "high",
        enable_reasoner: true,
      },
    });
    const { runtime } = createRuntime("agent-fallback", "conv-fallback");
    const socket = new MockSocket();

    let drainCount = 0;
    drainHandlers.set("conv-fallback", async () => {
      drainCount += 1;
      if (drainCount <= 2) {
        return {
          stopReason: "llm_api_error",
          approvals: [],
          apiDurationMs: 0,
        };
      }
      return defaultDrainResult;
    });

    await __listenClientTestUtils.handleIncomingMessage(
      makeIncomingMessage("agent-fallback", "conv-fallback", "run it"),
      socket as unknown as WebSocket,
      runtime,
    );

    expect(sendMessageStreamCalls.length).toBe(3);
    expect(sendMessageStreamCalls[0]?.opts?.overrideModel).toBe(
      "anthropic/claude-sonnet-5",
    );
    // First retry has not applied the fallback yet: still pinned.
    expect(sendMessageStreamCalls[1]?.opts?.overrideModel).toBe(
      "anthropic/claude-sonnet-5",
    );
    // Second retry applies the Bedrock fallback, which beats the snapshot.
    expect(sendMessageStreamCalls[2]?.opts?.overrideModel).toBe(
      "bedrock/us.anthropic.claude-sonnet-5",
    );
  }, 15000);
});
