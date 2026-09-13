import { afterEach, expect, mock, test } from "bun:test";
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
import { dispatchInboundMessageWhenReady } from "./inbound-dispatch";
import { createRuntime } from "./lifecycle";
import { getOrCreateConversationPermissionModeStateRef } from "./permission-mode";
import { setActiveRuntime } from "./runtime";
import { isListenerTransportOpen, type ListenerTransport } from "./transport";
import { handleApprovalStop } from "./turn-approval";
import { createTurnInputState } from "./turn-input-state";
import type { StartListenerOptions } from "./types";

class MockSocket {
  readonly bufferedAmount = 0;
  readyState: number = WebSocket.OPEN;
  readonly sent: unknown[] = [];

  isOpen(): boolean {
    return this.readyState === WebSocket.OPEN;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

function makeOptions(connectionId: string): StartListenerOptions {
  return {
    connectionId,
    wsUrl: "ws://app-server.test",
    deviceId: connectionId,
    connectionName: connectionId,
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
    options: makeOptions("client-a"),
  });
  openListenerConnection({
    runtime: listener,
    connectionId: "client-b",
    writer: socketB as never,
    options: makeOptions("client-b"),
  });
  markListenerConnectionInitialized(listener, "client-a");
  markListenerConnectionInitialized(listener, "client-b");
  const scope = { agent_id: "agent-1", conversation_id: "conversation-1" };
  subscribeListenerConnection(listener, "client-a", scope);
  subscribeListenerConnection(listener, "client-b", scope);

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
    options: makeOptions("client-a"),
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
          waitForApprovalTransportOpen: mock(
            async (
              transport: ListenerTransport,
            ): Promise<"open" | "interrupted"> =>
              isListenerTransportOpen(transport) ? "open" : "interrupted",
          ),
        } as never,
      });
    }),
    trackListenerError: mock(() => {}),
  });

  await waitFor(
    () => runtime.pendingApprovalResolvers.size > 0,
    "approval request was not registered",
  );
  expect(
    socketB.sent.some(
      (message) =>
        (message as { type?: string; request_id?: string }).type ===
          "control_request" &&
        (message as { request_id?: string }).request_id ===
          `perm-${approval.toolCallId}`,
    ),
  ).toBe(true);

  socketA.readyState = WebSocket.CLOSED;
  cleanupListenerConnection(listener, "client-a");
  expect(runtime.activeConnectionId).toBeNull();
  expect(listener.connections.has("client-b")).toBe(true);
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
      "client-b",
    ),
  ).toBe(true);

  await runtime.messageQueue;
  expect(branchResult?.kind).toBe("terminal");
  expect(executeApprovalBatch).toHaveBeenCalledTimes(1);
  expect(sendApprovalContinuation).toHaveBeenCalledTimes(1);
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
          waitForApprovalTransportOpen: mock(
            async (
              transport: ListenerTransport,
            ): Promise<"open" | "interrupted"> =>
              isListenerTransportOpen(transport) ? "open" : "interrupted",
          ),
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
