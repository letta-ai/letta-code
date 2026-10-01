import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import WebSocket from "ws";
import { STALE_APPROVAL_RECOVERY_DENIAL_REASON } from "@/agent/turn-recovery-policy";
import {
  getOrCreateProcessTransport,
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { cleanupListenerConnection } from "./connection-lifecycle";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { consumeInterruptQueue } from "./interrupts";
import { createRuntime } from "./lifecycle";
import { getOutboundQueueStats, OUTBOUND_QUEUE_LIMITS } from "./outbound-wire";
import { startRecoveredApprovalContinuation } from "./recovery";
import { clearConversationRuntimeState } from "./runtime";
import type { ListenerTransport } from "./transport";
import type { RecoveredApprovalState, StartListenerOptions } from "./types";

class MockSocket {
  bufferedAmount = 0;
  readyState: number = WebSocket.OPEN;
  readonly sent: unknown[] = [];
  onTerminate?: () => void;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
    this.onTerminate?.();
  }
}

function makeOptions(connectionId: string): StartListenerOptions {
  return {
    connectionId,
    wsUrl: "ws://app-server.test",
    deviceId: connectionId,
    connectionName: connectionId,
    connectionIdCanResume: false,
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

function createTransport(sentPayloads: string[]): ListenerTransport {
  return {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: (payload: string) => sentPayloads.push(payload),
  };
}

function createRecoveredState(): RecoveredApprovalState {
  const approval = {
    toolCallId: "call-1",
    toolName: "Bash",
    toolArgs: '{"command":"pwd"}',
  };
  return {
    agentId: "agent-1",
    conversationId: "conv-1",
    autoDecisions: [
      { type: "deny", approval, reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON },
    ],
    allApprovals: [approval],
  };
}

function createApprovedRecoveredState(): RecoveredApprovalState {
  const approval = {
    toolCallId: "call-approved",
    toolName: "Read",
    toolArgs: '{"file_path":"/tmp/example"}',
  };
  return {
    agentId: "agent-1",
    conversationId: "conv-1",
    autoDecisions: [{ type: "approve", approval }],
    allApprovals: [approval],
  };
}

function createToolResults() {
  return [
    {
      type: "tool" as const,
      tool_call_id: "call-approved",
      status: "success" as const,
      tool_return: "contents",
    },
  ];
}

function createDenialResults() {
  return [
    {
      type: "approval" as const,
      tool_call_id: "call-1",
      approve: false as const,
      reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
    },
  ];
}

function createPreparedToolContext() {
  return {
    toolset: "codex",
    toolsetPreference: "auto",
    preparedToolContext: {
      contextId: "context-1",
      loadedToolNames: [],
      clientTools: [],
      clientSkills: [],
    },
  } as never;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for recovered approval state");
}

afterEach(() => {
  mock.restore();
});

describe("recovered approval lease boundaries", () => {
  test("timed-out recovery replays terminal pairs to a later App Server owner", async () => {
    let now = 1_000;
    spyOn(Date, "now").mockImplementation(() => now);
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    runtime.recoveredApprovalState = createApprovedRecoveredState();
    runtime.activeConnectionId = "client-a";
    const socketA = new MockSocket();
    const socketB = new MockSocket();
    socketA.bufferedAmount =
      OUTBOUND_QUEUE_LIMITS.HIGH_WATERMARK_BUFFERED_BYTES;
    const scope = { agent_id: "agent-1", conversation_id: "conv-1" };
    openListenerConnection({
      runtime: listener,
      connectionId: "client-a",
      writer: socketA as never,
      options: makeOptions("client-a"),
    });
    markListenerConnectionInitialized(listener, "client-a");
    subscribeListenerConnection(listener, "client-a", scope);
    socketA.onTerminate = () => cleanupListenerConnection(listener, "client-a");
    const continuedConnectionIds: Array<string | undefined> = [];
    const continuedMessageConnectionIds: Array<string | undefined> = [];
    const submittedOtids: string[] = [];
    const recordedOtids: string[] = [];
    const processTurn = mock(
      async (
        message,
        _socket,
        ownerRuntime,
        _onStatusChange,
        connectionId,
        _batchId,
        turnLease,
      ) => {
        continuedConnectionIds.push(connectionId);
        continuedMessageConnectionIds.push(message.connectionId);
        const approvalMessage = message.messages[0] as { otid?: string };
        if (approvalMessage.otid) submittedOtids.push(approvalMessage.otid);
        if (turnLease) ownerRuntime.turnLifecycle.finish(turnLease, "end_turn");
      },
    );
    const handled = startRecoveredApprovalContinuation(
      runtime,
      getOrCreateProcessTransport(listener),
      processTurn,
      {
        connectionId: "client-a",
        dependencies: {
          ensureSecretsHydrated: async () => {},
          ensureModAdapters: async () => [],
          prepareToolExecutionContext: async () => createPreparedToolContext(),
          executeApprovalBatch: async () => createToolResults(),
          recordListenerWork: (_runtime, update) => {
            if (update.requestOtid) recordedOtids.push(update.requestOtid);
          },
        },
      },
    );
    await waitFor(
      () => getOutboundQueueStats(socketA as never).queuedFrames >= 3,
    );
    now += OUTBOUND_QUEUE_LIMITS.MAX_BACKPRESSURE_MS;
    await waitFor(() => getOutboundQueueStats(socketA as never).killed);
    openListenerConnection({
      runtime: listener,
      connectionId: "client-b",
      writer: socketB as never,
      options: makeOptions("client-b"),
    });
    markListenerConnectionInitialized(listener, "client-b");
    subscribeListenerConnection(listener, "client-b", scope);

    expect(await handled).toBe(true);
    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(runtime.turnLifecycle.kind).toBe("idle");
    const terminalTypes = socketB.sent
      .filter(
        (message) => (message as { type?: string }).type === "stream_delta",
      )
      .map(
        (message) =>
          (message as { delta?: { message_type?: string } }).delta
            ?.message_type,
      )
      .filter((messageType) =>
        ["client_tool_end", "tool_return_message"].includes(messageType ?? ""),
      );
    expect(terminalTypes).toEqual(["client_tool_end", "tool_return_message"]);
    expect(runtime.activeConnectionId).toBe("client-b");
    expect(continuedConnectionIds).toEqual(["client-b"]);
    expect(continuedMessageConnectionIds).toEqual(["client-b"]);
    expect(recordedOtids).toHaveLength(1);
    expect(recordedOtids).toEqual(submittedOtids);
  });

  test("a missing explicit process origin defers recovery for a later owner", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    runtime.recoveredApprovalState = createApprovedRecoveredState();
    runtime.activeConnectionId = "client-a";
    const socketA = new MockSocket();
    openListenerConnection({
      runtime: listener,
      connectionId: "client-a",
      writer: socketA as never,
      options: makeOptions("client-a"),
    });
    markListenerConnectionInitialized(listener, "client-a");
    subscribeListenerConnection(listener, "client-a", {
      agent_id: "agent-1",
      conversation_id: "conv-1",
    });
    cleanupListenerConnection(listener, "client-a");
    const processTurn = mock(
      async (
        _message,
        _socket,
        ownerRuntime,
        _onStatusChange,
        _connectionId,
        _batchId,
        turnLease,
      ) => {
        if (turnLease) ownerRuntime.turnLifecycle.finish(turnLease, "end_turn");
      },
    );

    expect(
      await startRecoveredApprovalContinuation(
        runtime,
        getOrCreateProcessTransport(listener),
        processTurn,
        {
          connectionId: "client-a",
          dependencies: {
            ensureSecretsHydrated: async () => {},
            ensureModAdapters: async () => [],
            prepareToolExecutionContext: async () =>
              createPreparedToolContext(),
            executeApprovalBatch: async () => createToolResults(),
          },
        },
      ),
    ).toBe(false);
    expect(processTurn).not.toHaveBeenCalled();
    expect(runtime.recoveredApprovalState).not.toBeNull();
    expect(runtime.turnLifecycle.kind).toBe("idle");
    expect(runtime.activeConnectionId).toBeNull();

    const socketB = new MockSocket();
    openListenerConnection({
      runtime: listener,
      connectionId: "client-b",
      writer: socketB as never,
      options: makeOptions("client-b"),
    });
    markListenerConnectionInitialized(listener, "client-b");
    subscribeListenerConnection(listener, "client-b", {
      agent_id: "agent-1",
      conversation_id: "conv-1",
    });
    expect(
      await startRecoveredApprovalContinuation(
        runtime,
        getOrCreateProcessTransport(listener),
        processTurn,
        {
          connectionId: "client-b",
          dependencies: {
            ensureSecretsHydrated: async () => {},
            ensureModAdapters: async () => [],
            prepareToolExecutionContext: async () =>
              createPreparedToolContext(),
            executeApprovalBatch: async () => createToolResults(),
          },
        },
      ),
    ).toBe(true);
    expect(processTurn).toHaveBeenCalledTimes(1);
  });

  test("thrown recovery replays its closing tool terminal to a later App Server owner", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    runtime.recoveredApprovalState = createApprovedRecoveredState();
    runtime.activeConnectionId = "client-a";
    const socketA = new MockSocket();
    const socketB = new MockSocket();
    socketA.bufferedAmount =
      OUTBOUND_QUEUE_LIMITS.HIGH_WATERMARK_BUFFERED_BYTES;
    const scope = { agent_id: "agent-1", conversation_id: "conv-1" };
    openListenerConnection({
      runtime: listener,
      connectionId: "client-a",
      writer: socketA as never,
      options: makeOptions("client-a"),
    });
    markListenerConnectionInitialized(listener, "client-a");
    subscribeListenerConnection(listener, "client-a", scope);
    const processTurn = mock(async () => {});
    const handled = startRecoveredApprovalContinuation(
      runtime,
      getOrCreateProcessTransport(listener),
      processTurn,
      {
        connectionId: "client-a",
        dependencies: {
          ensureSecretsHydrated: async () => {},
          ensureModAdapters: async () => [],
          prepareToolExecutionContext: async () => createPreparedToolContext(),
          executeApprovalBatch: async () => {
            throw new Error("recovery crashed");
          },
        },
      },
    );
    const handledOutcome = handled.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waitFor(
      () => getOutboundQueueStats(socketA as never).queuedFrames >= 2,
    );
    openListenerConnection({
      runtime: listener,
      connectionId: "client-b",
      writer: socketB as never,
      options: makeOptions("client-b"),
    });
    markListenerConnectionInitialized(listener, "client-b");
    subscribeListenerConnection(listener, "client-b", scope);
    socketA.readyState = WebSocket.CLOSED;
    cleanupListenerConnection(listener, "client-a");

    const outcome = await handledOutcome;
    expect(outcome).toHaveProperty("error");
    expect(processTurn).not.toHaveBeenCalled();
    expect(
      socketB.sent.some(
        (message) =>
          (message as { delta?: { message_type?: string } }).delta
            ?.message_type === "client_tool_end",
      ),
    ).toBe(true);
  });

  test("a dropped direct recovery terminal releases its lease", async () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    runtime.recoveredApprovalState = createApprovedRecoveredState();
    const transport = {
      kind: "local" as const,
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {
        throw new Error("transport failed");
      },
    } as ListenerTransport;
    const processTurn = mock(async () => {});
    const recordedOtids: string[] = [];

    expect(
      await startRecoveredApprovalContinuation(
        runtime,
        transport,
        processTurn,
        {
          dependencies: {
            ensureSecretsHydrated: async () => {},
            ensureModAdapters: async () => [],
            prepareToolExecutionContext: async () =>
              createPreparedToolContext(),
            executeApprovalBatch: async () => createToolResults(),
            recordListenerWork: (_runtime, update) => {
              if (update.requestOtid) recordedOtids.push(update.requestOtid);
            },
          },
        },
      ),
    ).toBe(true);
    expect(processTurn).not.toHaveBeenCalled();
    expect(runtime.turnLifecycle.kind).toBe("idle");
    expect(runtime.pendingInterruptedResults).toEqual(createToolResults());
    expect(runtime.pendingInterruptedToolCallIds).toEqual([]);
    expect(runtime.recoveredApprovalState).toBeNull();
    const queued = consumeInterruptQueue(runtime, "agent-1", "conv-1");
    expect(recordedOtids).toHaveLength(1);
    expect(queued?.approvalMessage.otid).toBe(recordedOtids[0]);
  });

  test("a queued user's identity survives recovered denial continuation", async () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    runtime.recoveredApprovalState = createRecoveredState();
    enqueueInboundUserMessage(
      runtime,
      {
        type: "message",
        agentId: "agent-1",
        conversationId: "conv-1",
        messages: [{ role: "user", content: "message from Charles" }],
      },
      "cloud-user-charles",
    );
    let receivedActingUserId: string | undefined;
    let receivedMessages: unknown;
    const recordedToolCallIds: string[][] = [];

    const handled = await startRecoveredApprovalContinuation(
      runtime,
      createTransport([]),
      async (
        message,
        _socket,
        ownerRuntime,
        _onStatusChange,
        _connectionId,
        _batchId,
        turnLease,
      ) => {
        receivedActingUserId = message.actingUserId;
        receivedMessages = message.messages;
        if (turnLease) ownerRuntime.turnLifecycle.finish(turnLease, "end_turn");
      },
      {
        dependencies: {
          ensureSecretsHydrated: async () => {},
          ensureModAdapters: async () => [],
          prepareToolExecutionContext: async () => createPreparedToolContext(),
          executeApprovalBatch: async () => createDenialResults(),
          recordListenerWork: (_runtime, update) => {
            if (update.toolCallIds)
              recordedToolCallIds.push(update.toolCallIds);
          },
        },
      },
    );

    expect(handled).toBe(true);
    expect(receivedActingUserId).toBeUndefined();
    expect(receivedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "approval",
          approvals: createDenialResults(),
        }),
      ]),
    );
    expect(JSON.stringify(receivedMessages)).toContain(
      '"attribution":{"acting_user_id":"cloud-user-charles"}',
    );
    expect(recordedToolCallIds).toEqual([["call-1"]]);
  });

  test("stale recovered denial processing emits nothing into a replacement run", async () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    runtime.recoveredApprovalState = createRecoveredState();
    const sentPayloads: string[] = [];
    let executionStarted = false;
    let resolveExecution!: (
      results: ReturnType<typeof createDenialResults>,
    ) => void;
    const execution = new Promise<ReturnType<typeof createDenialResults>>(
      (resolve) => {
        resolveExecution = resolve;
      },
    );
    const processTurn = mock(async () => {});
    const handled = startRecoveredApprovalContinuation(
      runtime,
      createTransport(sentPayloads),
      processTurn,
      {
        dependencies: {
          ensureSecretsHydrated: async () => {},
          ensureModAdapters: async () => [],
          prepareToolExecutionContext: async () => createPreparedToolContext(),
          executeApprovalBatch: async (decisions) => {
            expect(decisions).toEqual(
              createRecoveredState().autoDecisions ?? [],
            );
            executionStarted = true;
            return execution;
          },
        },
      },
    );
    await waitFor(() => executionStarted);

    clearConversationRuntimeState(runtime);
    const replacementLease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    runtime.turnLifecycle.setRunId(replacementLease, "replacement-run");
    sentPayloads.length = 0;
    resolveExecution(createDenialResults());

    expect(await handled).toBe(true);
    expect(processTurn).not.toHaveBeenCalled();
    expect(runtime.turnLifecycle.isCurrent(replacementLease)).toBe(true);
    expect(sentPayloads).toEqual([]);
  });

  test("aborted recovered denial processing that throws finalizes exactly once without tool starts", async () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    runtime.recoveredApprovalState = createRecoveredState();
    const sentPayloads: string[] = [];
    let executionStarted = false;
    let rejectExecution!: (error: Error) => void;
    const execution = new Promise<never[]>((_, reject) => {
      rejectExecution = reject;
    });
    const processTurn = mock(async () => {});
    const handled = startRecoveredApprovalContinuation(
      runtime,
      createTransport(sentPayloads),
      processTurn,
      {
        dependencies: {
          ensureSecretsHydrated: async () => {},
          ensureModAdapters: async () => [],
          prepareToolExecutionContext: async () => createPreparedToolContext(),
          executeApprovalBatch: async () => {
            executionStarted = true;
            return execution;
          },
        },
      },
    );
    await waitFor(() => executionStarted);

    runtime.turnLifecycle.requestCancellation();
    rejectExecution(new Error("denial processing crashed"));
    await handled.catch(() => {});

    const frames = sentPayloads.map((payload) => JSON.parse(payload));
    const terminals = frames.filter((frame) => frame.type === "turn_finished");
    expect(terminals).toHaveLength(1);
    expect(terminals[0].stop_reason).toBe("cancelled");
    expect(
      frames.filter(
        (frame) =>
          frame.type === "stream_delta" &&
          ["client_tool_start", "client_tool_end"].includes(
            frame.delta.message_type,
          ),
      ),
    ).toEqual([]);
    expect(runtime.turnLifecycle.kind).toBe("idle");
    expect(processTurn).not.toHaveBeenCalled();
  });

  test("terminated recovered denial processing omits terminal error details", async () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    runtime.recoveredApprovalState = createRecoveredState();
    const sentPayloads: string[] = [];
    const handled = startRecoveredApprovalContinuation(
      runtime,
      createTransport(sentPayloads),
      mock(async () => {}),
      {
        dependencies: {
          ensureSecretsHydrated: async () => {},
          ensureModAdapters: async () => [],
          prepareToolExecutionContext: async () => createPreparedToolContext(),
          executeApprovalBatch: async () => {
            throw new Error("terminated");
          },
        },
      },
    );

    await handled.catch(() => {});

    const terminal = sentPayloads
      .map((payload) => JSON.parse(payload))
      .find((frame) => frame.type === "turn_finished");
    expect(terminal).toMatchObject({
      type: "turn_finished",
      stop_reason: "error",
    });
    expect(terminal).not.toHaveProperty("error");
  });
});
