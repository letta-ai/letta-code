import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { getCronRunLogPath, readCronRunLogEntries } from "@/cron/run-log";
import { permissionMode } from "@/permissions/mode";
import type { CronPromptQueueItem } from "@/queue/queue-runtime";
import { sharedReminderProviders } from "@/reminders/engine";
import { settingsManager } from "@/settings-manager";
import { clearTools } from "@/tools/manager";
import { injectQueuedSkillContent } from "@/websocket/listener/skill-injection";
import type { ConversationRuntime } from "@/websocket/listener/types";

type MockStream = { conversationId: string; agentId?: string };
type DrainResult = {
  stopReason: string;
  approvals?: [];
  apiDurationMs: number;
};
type DrainChunkCallback = (event: {
  chunk: Record<string, unknown>;
  shouldOutput: boolean;
  errorInfo?: null;
}) => void;

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
  ): Promise<MockStream> => ({ conversationId, agentId: opts?.agentId }),
);
const getStreamToolContextIdMock = mock(() => null);
const drainRunIdsByConversation = new Map<string, string[]>();
const drainStreamWithResumeMock = mock(
  async (
    stream: MockStream,
    _buffers: unknown,
    _refresh: () => void,
    _abortSignal?: AbortSignal,
    _resumeCursor?: unknown,
    onChunk?: DrainChunkCallback,
  ) => {
    for (const runId of drainRunIdsByConversation.get(stream.conversationId) ??
      []) {
      onChunk?.({
        chunk: { run_id: runId },
        shouldOutput: false,
        errorInfo: null,
      });
    }
    return defaultDrainResult;
  },
);
const retrieveAgentMock = mock(async (agentId: string) => ({
  id: agentId,
  model: "anthropic/claude-sonnet-4",
}));
const retrieveConversationMock = mock(async (conversationId: string) => ({
  id: conversationId,
  model: null,
  in_context_message_ids: [],
}));
const getClientMock = mock(async () => ({
  agents: {
    retrieve: retrieveAgentMock,
    messages: { list: mock(async () => ({ getPaginatedItems: () => [] })) },
  },
  conversations: {
    retrieve: retrieveConversationMock,
    cancel: mock(async () => {}),
    messages: {
      stream: mock(
        async (conversationId: string): Promise<MockStream> => ({
          conversationId,
        }),
      ),
    },
  },
  messages: { retrieve: mock(async () => null) },
  runs: {
    retrieve: mock(async (runId: string) => ({
      id: runId,
      status: "completed",
    })),
  },
}));
const realStreamModule = await import("@/cli/helpers/stream");
const realDrainStreamWithResume = realStreamModule.drainStreamWithResume;
const realAgentMessageModule = await import("@/agent/message");
const realSendMessageStream = realAgentMessageModule.sendMessageStream;
const realGetStreamToolContextId =
  realAgentMessageModule.getStreamToolContextId;

mock.module("@/agent/message", () => ({
  sendMessageStream: sendMessageStreamMock,
  getStreamToolContextId: getStreamToolContextIdMock,
  getStreamRequestContext: () => undefined,
  getStreamRequestStartTime: () => undefined,
  buildConversationMessagesCreateRequestBody: (
    conversationId: string,
    messages: unknown[],
    opts?: { agentId?: string; streamTokens?: boolean; background?: boolean },
  ) => ({
    messages,
    streaming: true,
    stream_tokens: opts?.streamTokens ?? true,
    include_pings: true,
    background: opts?.background ?? true,
    client_skills: [],
    client_tools: [],
    include_compaction_messages: true,
    ...(conversationId === "default" && opts?.agentId
      ? { agent_id: opts.agentId }
      : {}),
  }),
}));
mock.module("@/cli/helpers/stream", () => ({
  ...realStreamModule,
  drainStreamWithResume: drainStreamWithResumeMock,
}));
mock.module("@/backend/api/client", () => ({
  getClient: getClientMock,
  getServerUrl: () => "https://example.test",
  clearLastSDKDiagnostic: () => {},
  consumeLastSDKDiagnostic: () => null,
}));

const listenClientModule = await import("@/websocket/listen-client");
const { __listenClientTestUtils } = listenClientModule;

class MockSocket {
  readyState = WebSocket.OPEN;
  sentPayloads: string[] = [];
  send(data: string): void {
    this.sentPayloads.push(data);
  }
}

const origSessionContext = sharedReminderProviders["session-context"];
const origAgentInfo = sharedReminderProviders["agent-info"];
const originalGetLocalProjectSettings = settingsManager.getLocalProjectSettings;
const originalGetSettings = settingsManager.getSettings;

describe("cron listener run lifecycle", () => {
  beforeEach(() => {
    sharedReminderProviders["session-context"] = async () => null;
    sharedReminderProviders["agent-info"] = async () => null;
    (settingsManager as typeof settingsManager).getSettings = (() => ({
      memoryReminderInterval: null,
    })) as typeof settingsManager.getSettings;
    (settingsManager as typeof settingsManager).getLocalProjectSettings = () =>
      ({}) as ReturnType<typeof settingsManager.getLocalProjectSettings>;
    injectQueuedSkillContent([]);
    clearTools();
    permissionMode.reset();
    drainRunIdsByConversation.clear();
    sendMessageStreamMock.mockClear();
    drainStreamWithResumeMock.mockClear();
    retrieveAgentMock.mockClear();
    retrieveConversationMock.mockClear();
    getClientMock.mockClear();
    __listenClientTestUtils.setActiveRuntime(null);
  });

  afterEach(() => {
    sharedReminderProviders["session-context"] = origSessionContext;
    sharedReminderProviders["agent-info"] = origAgentInfo;
    (settingsManager as typeof settingsManager).getSettings =
      originalGetSettings;
    (settingsManager as typeof settingsManager).getLocalProjectSettings =
      originalGetLocalProjectSettings;
    clearTools();
    permissionMode.reset();
    __listenClientTestUtils.setActiveRuntime(null);
  });

  afterAll(() => {
    sendMessageStreamMock.mockReset();
    // biome-ignore lint/suspicious/noExplicitAny: restoring captured implementation behind mock.module
    (sendMessageStreamMock as any).mockImplementation(realSendMessageStream);
    getStreamToolContextIdMock.mockReset();
    // biome-ignore lint/suspicious/noExplicitAny: restoring captured implementation behind mock.module
    (getStreamToolContextIdMock as any).mockImplementation(
      realGetStreamToolContextId,
    );
    drainStreamWithResumeMock.mockReset();
    // biome-ignore lint/suspicious/noExplicitAny: restoring captured implementation behind mock.module
    (drainStreamWithResumeMock as any).mockImplementation(
      realDrainStreamWithResume,
    );
    mock.restore();
  });

  test("consumeQueuedTurn carries cron metadata and logs dequeue", async () => {
    const originalLettaHome = process.env.LETTA_HOME;
    const cronHome = await mkdtemp(join(tmpdir(), "letta-cron-turn-"));
    try {
      process.env.LETTA_HOME = cronHome;
      const runtime = __listenClientTestUtils.createRuntime();
      const cronInput = {
        kind: "cron_prompt",
        source: "cron",
        text: "Scheduled task text",
        cronTaskId: "task-cron-1",
        cronRunId: "cron-run-1",
        agentId: "agent-1",
        conversationId: "conv-1",
      } satisfies Omit<CronPromptQueueItem, "id" | "enqueuedAt">;
      const cronItem = runtime.queueRuntime.enqueue(cronInput);
      if (!cronItem) throw new Error("Expected queued cron item");

      const consumed = __listenClientTestUtils.consumeQueuedTurn(runtime);
      if (!consumed) throw new Error("Expected consumed cron turn");
      expect(consumed.queuedTurn.cronRuns).toEqual([
        {
          cronTaskId: "task-cron-1",
          cronRunId: "cron-run-1",
          queueItemId: cronItem.id,
          batchId: consumed.dequeuedBatch.batchId,
          agentId: "agent-1",
          conversationId: "conv-1",
          enqueuedAt: cronItem.enqueuedAt,
        },
      ]);
      expect(consumed.queuedTurn.messages).toEqual([
        {
          role: "user",
          content: [{ type: "text", text: "Scheduled task text" }],
        },
      ]);
      expect(runtime.queueRuntime.length).toBe(0);
      expect(
        readCronRunLogEntries(getCronRunLogPath("task-cron-1"), {
          jobId: "task-cron-1",
          limit: 10,
        }),
      ).toEqual([
        expect.objectContaining({
          action: "dequeued",
          cronRunId: "cron-run-1",
          queueItemId: cronItem.id,
          batchId: consumed.dequeuedBatch.batchId,
          queueLenAfter: 0,
          mergedCount: 1,
        }),
      ]);
    } finally {
      if (originalLettaHome === undefined) delete process.env.LETTA_HOME;
      else process.env.LETTA_HOME = originalLettaHome;
      await rm(cronHome, { recursive: true, force: true });
    }
  });

  test("handleIncomingMessage logs cron turn lifecycle without prompt text", async () => {
    const originalLettaHome = process.env.LETTA_HOME;
    const cronHome = await mkdtemp(join(tmpdir(), "letta-cron-lifecycle-"));
    try {
      process.env.LETTA_HOME = cronHome;
      const agentId = "agent-cron-lifecycle";
      const conversationId = "conv-cron-lifecycle";
      const listener = __listenClientTestUtils.createListenerRuntime();
      const runtime: ConversationRuntime =
        __listenClientTestUtils.getOrCreateConversationRuntime(
          listener,
          agentId,
          conversationId,
        );
      drainRunIdsByConversation.set(conversationId, ["backend-run-cron-1"]);

      await __listenClientTestUtils.handleIncomingMessage(
        {
          type: "message",
          agentId,
          conversationId,
          cronRuns: [
            {
              cronTaskId: "task-cron-lifecycle",
              cronRunId: "cron-run-lifecycle",
              queueItemId: "q-cron-lifecycle",
              batchId: "batch-cron-lifecycle",
              agentId,
              conversationId,
            },
          ],
          messages: [
            { role: "user", content: "secret prompt text must not be logged" },
          ],
        },
        new MockSocket() as unknown as WebSocket,
        runtime,
        undefined,
        "conn-cron-lifecycle",
        "batch-cron-lifecycle",
      );

      const logPath = getCronRunLogPath("task-cron-lifecycle");
      const entries = readCronRunLogEntries(logPath, {
        jobId: "task-cron-lifecycle",
        limit: 10,
      });
      expect(entries.map((entry) => entry.action)).toEqual([
        "turn_started",
        "backend_run_started",
        "completed",
      ]);
      expect(entries).toEqual([
        expect.objectContaining({
          action: "turn_started",
          cronRunId: "cron-run-lifecycle",
          queueItemId: "q-cron-lifecycle",
          batchId: "batch-cron-lifecycle",
        }),
        expect.objectContaining({
          action: "backend_run_started",
          cronRunId: "cron-run-lifecycle",
          backendRunId: "backend-run-cron-1",
          runId: "backend-run-cron-1",
        }),
        expect.objectContaining({
          action: "completed",
          cronRunId: "cron-run-lifecycle",
          backendRunId: "backend-run-cron-1",
          runId: "backend-run-cron-1",
          stopReason: "end_turn",
        }),
      ]);
      expect(await readFile(logPath, "utf-8")).not.toContain(
        "secret prompt text",
      );
    } finally {
      if (originalLettaHome === undefined) delete process.env.LETTA_HOME;
      else process.env.LETTA_HOME = originalLettaHome;
      await rm(cronHome, { recursive: true, force: true });
    }
  });
});
