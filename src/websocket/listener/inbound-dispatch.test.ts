import { afterEach, expect, mock, spyOn, test } from "bun:test";
import WebSocket from "ws";
import type { ApprovalResult } from "@/agent/approval-execution";
import {
  rejectPendingApprovalResolversForConnection,
  replayPendingApprovalRequestsToConnection,
  resolvePendingApprovalResolver,
} from "./approval";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
  suspendListenerConnection,
} from "./connection";
import { cleanupListenerConnection } from "./connection-lifecycle";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  createIncomingMessage,
  dispatchInboundMessageWhenReady,
} from "./inbound-dispatch";
import {
  emitInterruptToolReturnMessage,
  emitToolExecutionFinishedEvents,
  getInterruptApprovalsForEmission,
  populateInterruptQueue,
} from "./interrupts";
import { createRuntime } from "./lifecycle";
import { getOutboundQueueStats, OUTBOUND_QUEUE_LIMITS } from "./outbound-wire";
import { getOrCreateConversationPermissionModeStateRef } from "./permission-mode";
import { shouldProcessInboundMessageDirectly } from "./queue";
import {
  evictConversationRuntimeIfIdle,
  getConversationRuntime,
  setActiveRuntime,
} from "./runtime";
import { handleApprovalStop } from "./turn-approval";
import { createTurnInputState } from "./turn-input-state";
import type { StartListenerOptions } from "./types";

class MockSocket {
  bufferedAmount = 0;
  readyState: number = WebSocket.OPEN;
  readonly sent: unknown[] = [];
  onSend?: (message: unknown) => void;
  onTerminate?: () => void;

  isOpen(): boolean {
    return this.readyState === WebSocket.OPEN;
  }

  send(data: string): void {
    const message = JSON.parse(data);
    this.sent.push(message);
    this.onSend?.(message);
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
    this.onTerminate?.();
  }
}

function makeOptions(
  connectionId: string,
  connectionIdCanResume = true,
): StartListenerOptions {
  return {
    connectionId,
    wsUrl: "ws://app-server.test",
    deviceId: connectionId,
    connectionName: connectionId,
    connectionIdCanResume,
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

afterEach(() => {
  setActiveRuntime(null);
  mock.restore();
});

test("preserves an explicit null-agent scope on inbound turns", () => {
  const incoming = createIncomingMessage(
    { agent_id: null, conversation_id: "agent-free" },
    { type: "input", messages: [{ role: "user", content: "hello" }] } as never,
  );
  expect(incoming.agentId).toBeNull();
});

test("completes approval terminals in the null-agent default scope", async () => {
  const listener = createRuntime();
  setActiveRuntime(listener);
  const socket = new MockSocket();
  openListenerConnection({
    runtime: listener,
    connectionId: "agent-free",
    writer: socket as never,
    options: makeOptions("agent-free"),
  });
  markListenerConnectionInitialized(listener, "agent-free");
  const scope = { agent_id: null, conversation_id: "default" };
  subscribeListenerConnection(listener, "agent-free", scope);
  const runtime = getOrCreateScopedRuntime(listener, null, "default");
  runtime.activeConnectionId = "agent-free";
  const approval = {
    toolCallId: "agent-free-tool",
    toolName: "Read",
    toolArgs: JSON.stringify({ file_path: "/tmp/example" }),
  };
  const turnLease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
    initialStatus: "PROCESSING_API_RESPONSE",
  });
  const resultPromise = handleApprovalStop({
    approvals: [approval],
    runtime,
    socket: socket as never,
    agentId: null,
    conversationId: "default",
    turnWorkingDirectory: process.cwd(),
    turnPermissionModeState: getOrCreateConversationPermissionModeStateRef(
      listener,
      null,
      "default",
    ),
    dequeuedBatchId: "batch-agent-free",
    runId: "run-agent-free",
    msgRunIds: ["run-agent-free"],
    turnInput: createTurnInputState([]),
    pendingNormalizationInterruptedToolCallIds: [],
    turnToolContextId: null,
    turnLease,
    originConnectionId: "agent-free",
    originConnectionCanResume: true,
    buildSendOptions: () => ({ streamTokens: true }),
    dependencies: {
      classifyApprovals: mock(async () => ({
        autoAllowed: [],
        autoDenied: [],
        needsUserInput: [
          {
            approval,
            permission: { decision: "ask" },
            context: null,
            parsedArgs: { file_path: "/tmp/example" },
          },
        ],
      })),
      executeApprovalBatch: mock(async () => [
        {
          type: "tool" as const,
          tool_call_id: approval.toolCallId,
          status: "success" as const,
          tool_return: "contents",
        },
      ]),
      ensureSecretsHydrated: mock(async () => {}),
      sendApprovalContinuation: mock(async () => ({
        kind: "terminal" as const,
        drainResult: { stopReason: "end_turn" as const, apiDurationMs: 0 },
      })),
    } as never,
  });
  await waitFor(
    () => runtime.pendingApprovalResolvers.size === 1,
    "agent-free approval was not registered",
  );
  expect(
    resolvePendingApprovalResolver(
      runtime,
      {
        request_id: `perm-${approval.toolCallId}`,
        decision: {
          behavior: "allow",
          selected_permission_suggestion_ids: [],
        },
      },
      "agent-free",
    ),
  ).toBe(true);

  await expect(resultPromise).resolves.toMatchObject({ kind: "terminal" });
  const terminalTypes = socket.sent
    .filter((message) => (message as { type?: string }).type === "stream_delta")
    .map(
      (message) =>
        (message as { delta?: { message_type?: string } }).delta?.message_type,
    )
    .filter((messageType) =>
      ["client_tool_end", "tool_return_message"].includes(messageType ?? ""),
    );
  expect(terminalTypes).toEqual(["client_tool_end", "tool_return_message"]);
});

test("interrupt terminals preserve subscribed null-agent/default scope", () => {
  const listener = createRuntime();
  setActiveRuntime(listener);
  const socket = new MockSocket();
  openListenerConnection({
    runtime: listener,
    connectionId: "agent-free-interrupt",
    writer: socket as never,
    options: makeOptions("agent-free-interrupt"),
  });
  markListenerConnectionInitialized(listener, "agent-free-interrupt");
  subscribeListenerConnection(listener, "agent-free-interrupt", {
    agent_id: null,
    conversation_id: "default",
  });
  const runtime = getOrCreateScopedRuntime(listener, null, "default");
  const approvals = [
    {
      type: "tool" as const,
      tool_call_id: "agent-free-call",
      status: "error" as const,
      tool_return: "Interrupted by user",
    },
  ];
  expect(
    populateInterruptQueue(runtime, {
      lastExecutionResults: approvals,
      lastExecutingToolCallIds: ["agent-free-call"],
      lastNeedsUserInputToolCallIds: [],
      agentId: null,
      conversationId: "default",
    }),
  ).toBe(true);
  const approvalsForEmission = getInterruptApprovalsForEmission(runtime, {
    lastExecutionResults: null,
    agentId: null,
    conversationId: "default",
  });
  expect(approvalsForEmission).toEqual(approvals);
  emitToolExecutionFinishedEvents(socket as never, runtime, {
    approvals: approvalsForEmission ?? [],
    runId: "run-agent-free-interrupt",
    agentId: null,
    conversationId: "default",
  });
  emitInterruptToolReturnMessage(
    socket as never,
    runtime,
    approvalsForEmission ?? [],
    "run-agent-free-interrupt",
  );

  const terminalTypes = socket.sent
    .filter((message) => (message as { type?: string }).type === "stream_delta")
    .map(
      (message) =>
        (message as { delta?: { message_type?: string } }).delta?.message_type,
    )
    .filter((messageType) =>
      ["client_tool_end", "tool_return_message"].includes(messageType ?? ""),
    );
  expect(terminalTypes).toEqual(["client_tool_end", "tool_return_message"]);
});

test("replays a timed-out thrown-tool terminal to a later App Server owner", async () => {
  let now = 1_000;
  spyOn(Date, "now").mockImplementation(() => now);
  const listener = createRuntime();
  setActiveRuntime(listener);
  const scope = { agent_id: "agent-1", conversation_id: "conversation-1" };
  const socketA = new MockSocket();
  const socketB = new MockSocket();
  socketA.bufferedAmount = OUTBOUND_QUEUE_LIMITS.HIGH_WATERMARK_BUFFERED_BYTES;
  openListenerConnection({
    runtime: listener,
    connectionId: "client-a",
    writer: socketA as never,
    options: makeOptions("client-a", false),
  });
  markListenerConnectionInitialized(listener, "client-a");
  subscribeListenerConnection(listener, "client-a", scope);
  socketA.onTerminate = () => cleanupListenerConnection(listener, "client-a");

  const runtime = getOrCreateScopedRuntime(
    listener,
    scope.agent_id,
    scope.conversation_id,
  );
  runtime.activeConnectionId = "client-a";
  const turnLease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
    initialStatus: "PROCESSING_API_RESPONSE",
  });
  const approval = {
    toolCallId: "throw-call",
    toolName: "Read",
    toolArgs: "{}",
  };
  let executionAttempted = false;
  const thrown = handleApprovalStop({
    approvals: [approval],
    runtime,
    socket: socketA as never,
    agentId: scope.agent_id,
    conversationId: scope.conversation_id,
    turnWorkingDirectory: process.cwd(),
    turnPermissionModeState: getOrCreateConversationPermissionModeStateRef(
      listener,
      scope.agent_id,
      scope.conversation_id,
    ),
    dequeuedBatchId: "batch-throw",
    runId: "run-throw",
    msgRunIds: ["run-throw"],
    turnInput: createTurnInputState([]),
    pendingNormalizationInterruptedToolCallIds: [],
    turnToolContextId: null,
    turnLease,
    originConnectionId: "client-a",
    originConnectionCanResume: false,
    buildSendOptions: () => ({ streamTokens: true }),
    dependencies: {
      classifyApprovals: mock(async () => ({
        autoAllowed: [
          {
            approval,
            permission: { decision: "allow" },
            context: null,
            parsedArgs: {},
          },
        ],
        autoDenied: [],
        needsUserInput: [],
      })),
      executeApprovalBatch: mock(async () => {
        executionAttempted = true;
        throw new Error("boom");
      }),
      ensureSecretsHydrated: mock(async () => {}),
      sendApprovalContinuation: mock(async () => {
        throw new Error("unused");
      }),
    } as never,
  });
  const thrownOutcome = thrown.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await waitFor(
    () =>
      executionAttempted &&
      getOutboundQueueStats(socketA as never).queuedFrames >= 2,
    "thrown-tool terminal was not queued behind backpressure",
  );
  now += OUTBOUND_QUEUE_LIMITS.MAX_BACKPRESSURE_MS;
  await waitFor(
    () => getOutboundQueueStats(socketA as never).killed,
    "origin transport did not time out under sustained backpressure",
  );
  openListenerConnection({
    runtime: listener,
    connectionId: "client-b",
    writer: socketB as never,
    options: makeOptions("client-b", false),
  });
  markListenerConnectionInitialized(listener, "client-b");
  subscribeListenerConnection(listener, "client-b", scope);

  const outcome = await thrownOutcome;
  expect(outcome).toHaveProperty("error");
  expect(
    socketB.sent.some(
      (message) =>
        (message as { delta?: { message_type?: string } }).delta
          ?.message_type === "client_tool_end",
    ),
  ).toBe(true);
  expect(runtime.activeConnectionId).toBe("client-b");
});

test("direct App Server turn follows a subscribed client after origin disconnect", async () => {
  const listener = createRuntime();
  setActiveRuntime(listener);
  const socketA = new MockSocket();
  const socketB = new MockSocket();
  openListenerConnection({
    runtime: listener,
    connectionId: "client-a",
    writer: socketA as never,
    options: makeOptions("client-a", false),
  });
  markListenerConnectionInitialized(listener, "client-a");
  const scope = { agent_id: "agent-1", conversation_id: "conversation-1" };
  subscribeListenerConnection(listener, "client-a", scope);

  const runtime = getOrCreateScopedRuntime(
    listener,
    scope.agent_id,
    scope.conversation_id,
  );
  const approval = {
    toolCallId: "read-after-failover",
    toolName: "Read",
    toolArgs: JSON.stringify({ file_path: "/tmp/example" }),
  };
  const executionResults = [
    {
      type: "tool" as const,
      tool_call_id: approval.toolCallId,
      status: "success" as const,
      tool_return: "contents",
    },
  ] satisfies ApprovalResult[];
  const executeApprovalBatch = mock(async () => executionResults);
  const sendApprovalContinuation = mock(async () => ({
    kind: "terminal" as const,
    drainResult: { stopReason: "end_turn" as const, apiDurationMs: 0 },
  }));
  let branchResult: Awaited<ReturnType<typeof handleApprovalStop>> | undefined;

  dispatchInboundMessageWhenReady({
    listener,
    runtime,
    incoming: {
      type: "message",
      connectionId: "client-a",
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
      messages: [{ role: "user", content: "Read the file" }],
    },
    socket: socketA as never,
    options: makeOptions("client-a", false),
    processQueuedTurn: mock(async () => {}),
    processIncomingMessage: mock(async (_incoming, turnTransport) => {
      runtime.activeConnectionId = "client-a";
      const turnLease = runtime.turnLifecycle.begin({
        origin: "message",
        workingDirectory: process.cwd(),
        initialStatus: "PROCESSING_API_RESPONSE",
      });
      runtime.turnLifecycle.setRunId(turnLease, "run-direct-failover");
      branchResult = await handleApprovalStop({
        approvals: [approval],
        runtime,
        socket: turnTransport,
        agentId: scope.agent_id,
        conversationId: scope.conversation_id,
        turnWorkingDirectory: process.cwd(),
        turnPermissionModeState: getOrCreateConversationPermissionModeStateRef(
          listener,
          scope.agent_id,
          scope.conversation_id,
        ),
        dequeuedBatchId: "batch-direct-failover",
        runId: "run-direct-failover",
        msgRunIds: ["run-direct-failover"],
        turnInput: createTurnInputState([]),
        pendingNormalizationInterruptedToolCallIds: [],
        turnToolContextId: null,
        turnLease,
        originConnectionId: "client-a",
        originConnectionCanResume: false,
        buildSendOptions: () => ({ streamTokens: true }),
        dependencies: {
          classifyApprovals: mock(async () => ({
            autoAllowed: [],
            autoDenied: [],
            needsUserInput: [
              {
                approval,
                permission: { decision: "ask" },
                context: null,
                parsedArgs: { file_path: "/tmp/example" },
              },
            ],
          })),
          executeApprovalBatch,
          ensureSecretsHydrated: mock(async () => {}),
          sendApprovalContinuation,
        } as never,
      });
    }),
    trackListenerError: mock(() => {}),
  });

  await waitFor(
    () => runtime.pendingApprovalResolvers.size > 0,
    "approval request was not registered",
  );
  socketA.onSend = (message) => {
    if (
      (message as { type?: string }).type === "stream_delta" &&
      (message as { delta?: { message_type?: string } }).delta?.message_type ===
        "client_tool_end"
    ) {
      socketA.bufferedAmount =
        OUTBOUND_QUEUE_LIMITS.HIGH_WATERMARK_BUFFERED_BYTES;
    }
  };
  expect(
    resolvePendingApprovalResolver(
      runtime,
      {
        request_id: `perm-${approval.toolCallId}`,
        decision: {
          behavior: "allow",
          selected_permission_suggestion_ids: [],
        },
      },
      "client-a",
    ),
  ).toBe(true);
  await waitFor(
    () => getOutboundQueueStats(socketA as never).queuedFrames === 1,
    "second terminal did not remain queued after the first was sent",
  );
  openListenerConnection({
    runtime: listener,
    connectionId: "client-b",
    writer: socketB as never,
    options: makeOptions("client-b", false),
  });
  markListenerConnectionInitialized(listener, "client-b");
  subscribeListenerConnection(listener, "client-b", scope);
  socketA.readyState = WebSocket.CLOSED;
  cleanupListenerConnection(listener, "client-a");
  expect(runtime.activeConnectionId).toBe("client-b");
  expect(listener.connections.has("client-b")).toBe(true);

  await runtime.messageQueue;
  expect(branchResult?.kind).toBe("terminal");
  expect(executeApprovalBatch).toHaveBeenCalledTimes(1);
  expect(sendApprovalContinuation).toHaveBeenCalledTimes(1);
  const terminalTypes = socketB.sent
    .filter(
      (message) =>
        (message as { type?: string }).type === "stream_delta" &&
        ["client_tool_end", "tool_return_message"].includes(
          ((message as { delta?: { message_type?: string } }).delta
            ?.message_type ?? "") as string,
        ),
    )
    .map(
      (message) =>
        (message as { delta: { message_type: string } }).delta.message_type,
    );
  expect(terminalTypes).toEqual(["client_tool_end", "tool_return_message"]);
});

test("direct remote turn follows the replacement WS pair after reconnect", async () => {
  const listener = createRuntime();
  setActiveRuntime(listener);
  const originalControl = new MockSocket();
  const originalStream = new MockSocket();
  openListenerConnection({
    runtime: listener,
    connectionId: "relay",
    writer: originalControl as never,
    streamWriter: originalStream as never,
    options: makeOptions("relay"),
  });
  markListenerConnectionInitialized(listener, "relay");
  const scope = { agent_id: "agent-1", conversation_id: "conversation-1" };
  subscribeListenerConnection(listener, "relay", scope);

  const runtime = getOrCreateScopedRuntime(
    listener,
    scope.agent_id,
    scope.conversation_id,
  );
  const approval = {
    toolCallId: "read-after-reconnect",
    toolName: "Read",
    toolArgs: JSON.stringify({ file_path: "/tmp/example" }),
  };
  const executionResults = [
    {
      type: "tool" as const,
      tool_call_id: approval.toolCallId,
      status: "success" as const,
      tool_return: "contents",
    },
  ] satisfies ApprovalResult[];
  const executeApprovalBatch = mock(async () => executionResults);
  const sendApprovalContinuation = mock(async () => ({
    kind: "terminal" as const,
    drainResult: { stopReason: "end_turn" as const, apiDurationMs: 0 },
  }));
  let branchResult: Awaited<ReturnType<typeof handleApprovalStop>> | undefined;

  dispatchInboundMessageWhenReady({
    listener,
    runtime,
    incoming: {
      type: "message",
      connectionId: "relay",
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
      messages: [{ role: "user", content: "Read the file" }],
    },
    socket: originalControl as never,
    options: makeOptions("relay"),
    processQueuedTurn: mock(async () => {}),
    processIncomingMessage: mock(async (_incoming, turnTransport) => {
      runtime.activeConnectionId = "relay";
      const turnLease = runtime.turnLifecycle.begin({
        origin: "message",
        workingDirectory: process.cwd(),
        initialStatus: "PROCESSING_API_RESPONSE",
      });
      runtime.turnLifecycle.setRunId(turnLease, "run-direct-reconnect");
      branchResult = await handleApprovalStop({
        approvals: [approval],
        runtime,
        socket: turnTransport,
        agentId: scope.agent_id,
        conversationId: scope.conversation_id,
        turnWorkingDirectory: process.cwd(),
        turnPermissionModeState: getOrCreateConversationPermissionModeStateRef(
          listener,
          scope.agent_id,
          scope.conversation_id,
        ),
        dequeuedBatchId: "batch-direct-reconnect",
        runId: "run-direct-reconnect",
        msgRunIds: ["run-direct-reconnect"],
        turnInput: createTurnInputState([]),
        pendingNormalizationInterruptedToolCallIds: [],
        turnToolContextId: null,
        turnLease,
        originConnectionId: "relay",
        originConnectionCanResume: true,
        buildSendOptions: () => ({ streamTokens: true }),
        dependencies: {
          classifyApprovals: mock(async () => ({
            autoAllowed: [],
            autoDenied: [],
            needsUserInput: [
              {
                approval,
                permission: { decision: "ask" },
                context: null,
                parsedArgs: { file_path: "/tmp/example" },
              },
            ],
          })),
          executeApprovalBatch,
          ensureSecretsHydrated: mock(async () => {}),
          sendApprovalContinuation,
        } as never,
      });
    }),
    trackListenerError: mock(() => {}),
  });

  await waitFor(
    () => runtime.pendingApprovalResolvers.size > 0,
    "approval request was not registered",
  );

  originalControl.readyState = WebSocket.CLOSED;
  originalStream.readyState = WebSocket.CLOSED;
  rejectPendingApprovalResolversForConnection(
    runtime,
    "relay",
    "Listener connection closed",
  );
  suspendListenerConnection(listener, "relay");

  const replacementControl = new MockSocket();
  const replacementStream = new MockSocket();
  openListenerConnection({
    runtime: listener,
    connectionId: "relay",
    writer: replacementControl as never,
    streamWriter: replacementStream as never,
    options: makeOptions("relay"),
  });
  markListenerConnectionInitialized(listener, "relay");
  replayPendingApprovalRequestsToConnection(runtime, "relay");
  expect(
    replacementControl.sent.some(
      (message) =>
        (message as { type?: string; request_id?: string }).type ===
          "control_request" &&
        (message as { request_id?: string }).request_id ===
          `perm-${approval.toolCallId}`,
    ),
  ).toBe(true);

  expect(
    resolvePendingApprovalResolver(
      runtime,
      {
        request_id: `perm-${approval.toolCallId}`,
        decision: {
          behavior: "allow",
          selected_permission_suggestion_ids: [],
        },
      },
      "relay",
    ),
  ).toBe(true);

  await runtime.messageQueue;
  expect(branchResult?.kind).toBe("terminal");
  expect(executeApprovalBatch).toHaveBeenCalledTimes(1);
  expect(sendApprovalContinuation).toHaveBeenCalledTimes(1);
});

test("direct turn dispatched during previous turn cleanup keeps reporting its loop status", async () => {
  const listener = createRuntime();
  setActiveRuntime(listener);
  const socket = new MockSocket();
  openListenerConnection({
    runtime: listener,
    connectionId: "sdk",
    writer: socket as never,
    options: makeOptions("sdk"),
  });
  markListenerConnectionInitialized(listener, "sdk");
  const scope = { agent_id: "agent-1", conversation_id: "conversation-1" };
  subscribeListenerConnection(listener, "sdk", scope);
  const runtime = getOrCreateScopedRuntime(
    listener,
    scope.agent_id,
    scope.conversation_id,
  );

  // Turn A mirrors handleIncomingMessage: terminal transition, then awaited
  // post-turn cleanup, then evictConversationRuntimeIfIdle (turn.ts finally).
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let turnAFinished = false;
  dispatchInboundMessageWhenReady({
    listener,
    runtime,
    incoming: {
      type: "message",
      connectionId: "sdk",
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
      messages: [{ role: "user", content: "turn A" }],
    },
    socket: socket as never,
    options: makeOptions("sdk"),
    processQueuedTurn: mock(async () => {}),
    processIncomingMessage: mock(async () => {
      const lease = runtime.turnLifecycle.begin({
        origin: "message",
        workingDirectory: process.cwd(),
      });
      runtime.turnLifecycle.finish(lease, "end_turn");
      turnAFinished = true;
      await cleanupGate;
      evictConversationRuntimeIfIdle(runtime);
    }),
    trackListenerError: mock(() => {}),
  });
  await waitFor(() => turnAFinished, "turn A did not finish");

  // Turn B arrives while A is still in cleanup. The router resolves the same
  // runtime and, because the lifecycle is idle, routes it directly.
  const scopedRuntime = getOrCreateScopedRuntime(
    listener,
    scope.agent_id,
    scope.conversation_id,
  );
  expect(scopedRuntime).toBe(runtime);
  const incomingB = {
    type: "message" as const,
    connectionId: "sdk",
    agentId: scope.agent_id,
    conversationId: scope.conversation_id,
    messages: [{ role: "user" as const, content: "printf MARKER" }],
  };
  expect(shouldProcessInboundMessageDirectly(scopedRuntime, incomingB)).toBe(
    true,
  );

  const approval = {
    toolCallId: "exec-marker",
    toolName: "Bash",
    toolArgs: JSON.stringify({ command: "printf MARKER" }),
  };
  let releaseTool!: () => void;
  const toolGate = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  let toolRunning = false;
  let loopStatusDuringTool: string[] = [];
  const statusFrames = () =>
    socket.sent
      .filter(
        (message) =>
          (message as { type?: string }).type === "update_loop_status",
      )
      .map(
        (message) =>
          (message as { loop_status: { status: string } }).loop_status.status,
      );
  dispatchInboundMessageWhenReady({
    listener,
    runtime: scopedRuntime,
    incoming: incomingB,
    socket: socket as never,
    options: makeOptions("sdk"),
    processQueuedTurn: mock(async () => {}),
    processIncomingMessage: mock(
      async (_incoming, turnTransport, turnRuntime) => {
        const turnLease = turnRuntime.turnLifecycle.begin({
          origin: "message",
          workingDirectory: process.cwd(),
          initialStatus: "PROCESSING_API_RESPONSE",
        });
        turnRuntime.turnLifecycle.setRunId(turnLease, "run-b");
        const framesBeforeTool = statusFrames().length;
        await handleApprovalStop({
          approvals: [approval],
          runtime: turnRuntime,
          socket: turnTransport,
          agentId: scope.agent_id,
          conversationId: scope.conversation_id,
          turnWorkingDirectory: process.cwd(),
          turnPermissionModeState:
            getOrCreateConversationPermissionModeStateRef(
              listener,
              scope.agent_id,
              scope.conversation_id,
            ),
          dequeuedBatchId: "batch-b",
          runId: "run-b",
          msgRunIds: ["run-b"],
          turnInput: createTurnInputState([]),
          pendingNormalizationInterruptedToolCallIds: [],
          turnToolContextId: null,
          turnLease,
          buildSendOptions: () => ({ streamTokens: true }),
          dependencies: {
            classifyApprovals: mock(async () => ({
              autoAllowed: [
                {
                  approval,
                  permission: { decision: "allow" },
                  context: null,
                  parsedArgs: { command: "printf MARKER" },
                },
              ],
              autoDenied: [],
              needsUserInput: [],
            })),
            executeApprovalBatch: mock(async () => {
              toolRunning = true;
              loopStatusDuringTool = statusFrames().slice(framesBeforeTool);
              await toolGate;
              return [
                {
                  type: "tool" as const,
                  tool_call_id: approval.toolCallId,
                  status: "success" as const,
                  tool_return: "MARKER",
                },
              ] satisfies ApprovalResult[];
            }),
            ensureSecretsHydrated: mock(async () => {}),
            sendApprovalContinuation: mock(async () => ({
              kind: "terminal" as const,
              drainResult: {
                stopReason: "end_turn" as const,
                apiDurationMs: 0,
              },
            })),
            waitForApprovalTransportOpen: mock(
              async (): Promise<"open" | "interrupted"> => "open",
            ),
          } as never,
        });
        turnRuntime.turnLifecycle.finish(turnLease, "end_turn");
      },
    ),
    trackListenerError: mock(() => {}),
  });

  releaseCleanup();
  await waitFor(() => toolRunning, "turn B tool did not start");

  expect(loopStatusDuringTool).toContain("EXECUTING_CLIENT_SIDE_TOOL");
  expect(loopStatusDuringTool).not.toContain("WAITING_ON_INPUT");
  expect(
    getConversationRuntime(listener, scope.agent_id, scope.conversation_id),
  ).toBe(runtime);

  releaseTool();
  await runtime.messageQueue;
});

test("failed enqueue plus failed durable rollback acknowledges retained work", async () => {
  const listener = createRuntime();
  setActiveRuntime(listener);
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  const accepted: Array<{ accepted: boolean; disposition?: string }> = [];
  const restoreDurableQueuedInputs = mock(() => 0);
  listener.restoreDurableQueuedInputs = restoreDurableQueuedInputs;

  dispatchInboundMessageWhenReady({
    listener,
    runtime,
    incoming: {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [
        {
          role: "user",
          content: "retained after rollback failure",
          client_message_id: "cm-retained",
        },
      ],
    },
    socket: new MockSocket() as never,
    options: makeOptions("sdk"),
    processQueuedTurn: async () => {},
    processIncomingMessage: async () => {},
    trackListenerError: () => {},
    onInputAccepted: (result) => accepted.push(result),
    forgetQueuedInput: () => false,
    enqueueInput: () => false,
  });
  await runtime.messageQueue;
  await new Promise((resolve) => setImmediate(resolve));

  expect(accepted).toEqual([{ accepted: true, disposition: "queued" }]);
  expect(restoreDurableQueuedInputs).toHaveBeenCalledTimes(1);
});
