import { describe, expect, test } from "bun:test";
import type { ApprovalDecision } from "@/agent/approval-execution";
import { clearPendingMessages } from "@/utils/message-queue-bridge";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { startRecoveredApprovalContinuation } from "./recovery";
import { recoverApprovalStateForSync } from "./recovery-sync";
import { replaySyncStateForRuntime } from "./sync-replay";
import {
  claimPendingTeleportAtBoundary,
  clearExpectedInboundTeleport,
  expectInboundTeleport,
  finishTeleport,
  handleTeleportRequest,
  isInboundTeleportExpected,
  isRuntimeTeleportPending,
} from "./teleport";
import type { LocalTransport } from "./transport";
import type {
  ConversationRuntime,
  IncomingMessage,
  StartListenerOptions,
} from "./types";

class MockTransport implements LocalTransport {
  readonly kind = "local" as const;
  readonly bufferedAmount = 0;
  readonly sent: string[] = [];

  isOpen(): boolean {
    return true;
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

const scope = {
  agent_id: "agent-sync-teleport-fixture",
  conversation_id: "conv-sync-teleport-fixture",
} as const;

// The source's yielded MessageChannel call: replay-unsafe, so sync recovery
// classifies it as a stale denial with nothing waiting on a human.
const sourceYieldedApproval = {
  toolCallId: "call-message-channel-1",
  toolName: "MessageChannel",
  toolArgs: '{"action":"send","channel":"slack","message":"hi"}',
};

function connectRuntime(): {
  runtime: ConversationRuntime;
  transport: MockTransport;
} {
  clearPendingMessages();
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-sync-teleport-fixture",
    "conv-sync-teleport-fixture",
  );
  const transport = new MockTransport();
  const options: StartListenerOptions = {
    connectionId: "cloud-relay",
    wsUrl: "local://cloud-relay",
    deviceId: "test-device",
    connectionName: "cloud-relay",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  openListenerConnection({
    runtime: runtime.listener,
    connectionId: options.connectionId,
    writer: transport,
    options,
  });
  markListenerConnectionInitialized(runtime.listener, options.connectionId);
  return { runtime, transport };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for the recovered continuation");
}

async function sync(
  runtime: ConversationRuntime,
  transport: MockTransport,
  processed: IncomingMessage[],
): Promise<void> {
  await replaySyncStateForRuntime(runtime.listener, transport as never, scope, {
    scheduleWarmupsAfterSync: () => {},
    // The strongest ask an owner can make; the teleport gate must still win.
    recoverApprovals: true,
    resumeInterruptedTurn: true,
    forceDeviceStatus: true,
    connectionId: "cloud-relay",
    recoverApprovalStateForSync: async (
      scopedRuntime,
      recoveredScope,
      _deps,
      recoverOpts,
    ) => {
      return recoverApprovalStateForSync(
        scopedRuntime,
        recoveredScope,
        {
          getBackend: (() => ({
            retrieveAgent: async () => ({ id: "agent-sync-teleport-fixture" }),
          })) as never,
          getResumeDataFromBackend: (async () => ({
            pendingApproval: sourceYieldedApproval,
            pendingApprovals: [sourceYieldedApproval],
            messageHistory: [],
          })) as never,
        },
        recoverOpts,
      );
    },
    recoveredContinuationDependencies: {
      ensureSecretsHydrated: async () => {},
      prepareToolExecutionContext: async () =>
        ({
          toolset: "codex",
          toolsetPreference: "auto",
          preparedToolContext: {
            contextId: "context-1",
            loadedToolNames: [],
            clientTools: [],
            clientSkills: [],
          },
        }) as never,
      executeApprovalBatch: (async (decisions: ApprovalDecision[]) =>
        decisions.map((decision) => ({
          type: "approval" as const,
          tool_call_id: decision.approval.toolCallId,
          approve: false,
          reason: decision.type === "deny" ? decision.reason : undefined,
        }))) as never,
    },
    processIncomingMessage: async (
      message,
      _socket,
      ownerRuntime,
      _onStatusChange,
      _connectionId,
      _batchId,
      turnLease,
    ) => {
      processed.push(message);
      if (turnLease) ownerRuntime.turnLifecycle.finish(turnLease, "end_turn");
    },
  });
}

describe("sync replay on a teleport source", () => {
  test("independent sync callers do not deny the successfully yielded tool", async () => {
    const { runtime, transport } = connectRuntime();
    const processed: IncomingMessage[] = [];
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    handleTeleportRequest({
      listener: runtime.listener,
      connectionId: "cloud-relay",
      command: {
        type: "teleport_request",
        request_id: "source-teleport",
        teleport_id: "source-teleport",
        runtime: scope,
        target: {
          connection_id: "target",
          device_id: "target-device",
          connection_name: "Target",
        },
      },
    });
    const pending = claimPendingTeleportAtBoundary({
      listener: runtime.listener,
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
      activeTurn: true,
      continuation: {
        approvals: [
          {
            type: "approval",
            tool_call_id: sourceYieldedApproval.toolCallId,
            approve: true,
          },
        ],
      },
    });
    if (!pending) throw new Error("Expected pending source handoff");
    finishTeleport(runtime, lease, pending);
    await sync(runtime, transport, processed);
    await sync(runtime, transport, processed);
    await Bun.sleep(20);
    expect(processed).toHaveLength(0);
    expect(runtime.recoveredApprovalState).toBeNull();
    runtime.recoveredApprovalState = {
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
      approvalsByRequestId: new Map(),
      pendingRequestIds: new Set(),
      responsesByRequestId: new Map(),
      autoDecisions: [
        { type: "deny", approval: sourceYieldedApproval, reason: "stale" },
      ],
      allApprovals: [sourceYieldedApproval],
    };
    expect(
      await startRecoveredApprovalContinuation(runtime, transport, async () => {
        throw new Error("Source must not resume");
      }),
    ).toBe(false);
    runtime.recoveredApprovalState = null;
    expect(runtime.turnLifecycle.kind).toBe("idle");
    expect(
      isRuntimeTeleportPending(
        runtime.listener,
        scope.agent_id,
        scope.conversation_id,
      ),
    ).toBe(true);
    await sync(runtime, transport, processed);
    await sync(runtime, transport, processed);
    await Bun.sleep(20);
    expect(processed).toHaveLength(0);
    expect(runtime.recoveredApprovalState).toBeNull();
  });
});

describe("sync replay on a teleport destination", () => {
  test("does not finish the source's pending approvals while teleport_continue is expected", async () => {
    const { runtime, transport } = connectRuntime();
    const processed: IncomingMessage[] = [];
    expectInboundTeleport(runtime, "teleport-1");

    // Destination runtime_start replay, then the Slack gateway's own
    // runtime_start replay a moment later: neither may start a turn.
    await sync(runtime, transport, processed);
    await sync(runtime, transport, processed);
    await Bun.sleep(5);

    expect(runtime.listener.conversationRuntimes.get(runtime.key)).toBe(
      runtime,
    );
    expect(processed).toHaveLength(0);
    expect(runtime.isProcessing).toBe(false);
    expect(runtime.recoveredApprovalState).toBeNull();
    const statusFrames = transport.sent
      .map((payload) => JSON.parse(payload))
      .filter((frame) => frame.type === "update_loop_status");
    expect(statusFrames.length).toBeGreaterThan(0);
    for (const frame of statusFrames) {
      expect(frame.loop_status.status).toBe("WAITING_ON_INPUT");
    }

    // Once the continuation has arrived (the router clears the expectation),
    // a later sync may again resume an interrupted turn on its own.
    clearExpectedInboundTeleport(runtime);
    await sync(runtime, transport, processed);
    await waitFor(() => processed.length === 1);
    expect(processed[0]?.messages[0]).toMatchObject({
      type: "approval",
      approvals: [
        expect.objectContaining({
          tool_call_id: "call-message-channel-1",
          approve: false,
        }),
      ],
    });
  });

  test("an expectation whose teleport_continue never arrived expires", async () => {
    const { runtime, transport } = connectRuntime();
    const processed: IncomingMessage[] = [];
    expectInboundTeleport(runtime, "teleport-lost");
    runtime.expectedTeleportExpiresAt = Date.now() - 1;

    expect(isInboundTeleportExpected(runtime)).toBe(false);
    expect(runtime.expectedTeleportId).toBeNull();

    await sync(runtime, transport, processed);
    await waitFor(() => processed.length === 1);
  });
});
