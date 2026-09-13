import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ApprovalDecision } from "@/agent/approval-execution";
import { STALE_APPROVAL_RECOVERY_DENIAL_REASON } from "@/agent/turn-recovery-policy";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime, safeSocketSend } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { recoverApprovalStateForSync } from "./recovery-sync";
import { getPendingControlRequests, setActiveRuntime } from "./runtime";
import { replaySyncStateForRuntime as replayState } from "./sync-replay";
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

function createScopedRuntime(): ConversationRuntime {
  return getOrCreateScopedRuntime(createRuntime(), "agent-1", "conv-1");
}

const scope = { agent_id: "agent-1", conversation_id: "conv-1" } as const;

// Exercise startup recovery through the sync wire command. runtime_start
// shares the replay helper but must not inherit sync's first-start override.
async function replaySyncStateForRuntime(
  ...args: Parameters<typeof replayState>
): Promise<void> {
  const [listener, socket, runtimeScope, options] = args;
  setActiveRuntime(listener);
  const handler = createListenerMessageHandler({
    runtime: listener,
    socket,
    opts: {
      connectionId: "cloud-relay",
      wsUrl: "local://cloud-relay",
      deviceId: "test-device",
      connectionName: "cloud-relay",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    },
    processQueuedTurn: async () => {},
    processIncomingMessage: async () => {},
    fileCommandSession: { handle: () => false },
    getParsedRuntimeScope: () => null,
    replaySyncStateForRuntime: (owner, transport, recoveredScope, requested) =>
      replayState(owner, transport, recoveredScope, {
        ...options,
        ...requested,
      }),
    getOrCreateScopedRuntime,
    handleApprovalResponseInput: async () => false,
    handleChangeDeviceStateInput: async () => false,
    handleAbortMessageInput: async () => false,
    stampInboundUserMessageOtids: (incoming) => incoming,
    safeSocketSend,
    runDetachedListenerTask: (_label, task) => {
      void task();
    },
    trackListenerError: (error) => {
      throw error;
    },
  });
  try {
    await handler(
      Buffer.from(
        JSON.stringify({
          type: "sync",
          runtime: runtimeScope,
          recover_approvals: options?.recoverApprovals,
          force_device_status: options?.forceDeviceStatus,
        }),
      ),
    );
  } finally {
    setActiveRuntime(null);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for recovered continuation");
}

function createDeps(
  pendingApprovals: Array<{
    toolCallId: string;
    toolName: string;
    toolArgs: string;
  }>,
) {
  return {
    getBackend: (() => ({
      retrieveAgent: async () => ({ id: "agent-1" }),
    })) as never,
    getResumeDataFromBackend: (async () => ({
      pendingApproval: pendingApprovals[0] ?? null,
      pendingApprovals,
      messageHistory: [],
    })) as never,
  };
}

const askUserQuestionApproval = {
  toolCallId: "call-ask-1",
  toolName: "AskUserQuestion",
  toolArgs: JSON.stringify({
    questions: [
      {
        question: "Proceed?",
        header: "Plan",
        options: [
          { label: "Yes", description: "Go ahead" },
          { label: "No", description: "Stop" },
        ],
      },
    ],
  }),
};

const bashApproval = {
  toolCallId: "call-bash-1",
  toolName: "Bash",
  toolArgs: '{"command":"pwd"}',
};

function connectRuntime(runtime: ConversationRuntime): MockTransport {
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
  return transport;
}

describe("recoverApprovalStateForSync restart recovery", () => {
  test("destination registration can disable recovery before teleport continuation", async () => {
    const runtime = createScopedRuntime();
    const transport = connectRuntime(runtime);
    let recoveryCalls = 0;
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    await replayState(runtime.listener, transport as never, scope, {
      recoverApprovals: false,
      recoverApprovalStateForSync: async (owner, recoveredScope) => {
        recoveryCalls += 1;
        await recoverApprovalStateForSync(
          owner,
          recoveredScope,
          createDeps([bashApproval]),
        );
      },
      recoveredContinuationDependencies: {
        ensureSecretsHydrated: async () => {
          await recoveryGate;
          // Cleanup only: on the broken implementation recovery has already
          // taken the turn lease before teleport_continue can arrive.
          throw new Error("Unexpected recovery during teleport setup");
        },
      },
      scheduleWarmupsAfterSync: () => {},
    });
    try {
      expect(runtime.isProcessing).toBe(false);
      expect(recoveryCalls).toBe(0);
      expect(runtime.syncApprovalRecoveryCompleted).toBe(false);
      expect(runtime.recoveredApprovalState).toBeNull();
    } finally {
      releaseRecovery();
    }
  });

  test("sync publishes a recovered question as a control request", async () => {
    const runtime = createScopedRuntime();
    const transport = connectRuntime(runtime);

    await replaySyncStateForRuntime(
      runtime.listener,
      transport as never,
      scope,
      {
        recoverApprovalStateForSync: async (scopedRuntime, recoveredScope) => {
          await recoverApprovalStateForSync(
            scopedRuntime,
            recoveredScope,
            createDeps([askUserQuestionApproval]),
          );
        },
        forceDeviceStatus: true,
      },
    );

    const frames = transport.sent.map((payload) => JSON.parse(payload));
    expect(frames.map((frame) => frame.type)).toEqual([
      "control_request",
      "update_device_status",
      "update_loop_status",
      "update_queue",
      "update_subagent_state",
    ]);
    expect(frames[0]).toMatchObject({
      type: "control_request",
      request_id: "perm-call-ask-1",
      runtime: scope,
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_call_id: "call-ask-1",
        input: JSON.parse(askUserQuestionApproval.toolArgs),
      },
    });

    transport.sent.length = 0;
    await replaySyncStateForRuntime(
      runtime.listener,
      transport as never,
      scope,
      {
        recoverApprovals: false,
        forceDeviceStatus: true,
      },
    );
    expect(transport.sent.map((payload) => JSON.parse(payload).type)).toContain(
      "control_request",
    );
  });

  test("re-presents a pending AskUserQuestion as a live control request", async () => {
    const runtime = createScopedRuntime();

    await recoverApprovalStateForSync(
      runtime,
      scope,
      createDeps([askUserQuestionApproval]),
    );

    expect(runtime.pendingInterruptedResults).toBeNull();
    expect(runtime.pendingInterruptedContext).toBeNull();
    expect(runtime.recoveredApprovalState).not.toBeNull();
    expect(runtime.recoveredApprovalState?.pendingRequestIds).toEqual(
      new Set(["perm-call-ask-1"]),
    );

    const pending = getPendingControlRequests(runtime.listener, scope);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.request_id).toBe("perm-call-ask-1");
    expect(pending[0]?.request.tool_name).toBe("AskUserQuestion");
    expect(pending[0]?.request.tool_call_id).toBe("call-ask-1");
    expect(pending[0]?.request.input).toEqual(
      JSON.parse(askUserQuestionApproval.toolArgs),
    );
  });

  test("stale-only recovery keeps the denials on recovered state with nothing pending", async () => {
    const runtime = createScopedRuntime();

    await recoverApprovalStateForSync(
      runtime,
      scope,
      createDeps([bashApproval]),
    );

    // Nothing parks for a later user message: the sync caller sends these
    // denials as the next turn itself.
    expect(runtime.pendingInterruptedResults).toBeNull();
    expect(runtime.pendingInterruptedContext).toBeNull();
    const recovered = runtime.recoveredApprovalState;
    expect(recovered?.pendingRequestIds.size).toBe(0);
    expect(recovered?.approvalsByRequestId.size).toBe(0);
    expect(recovered?.autoDecisions).toEqual([
      {
        type: "deny",
        approval: bashApproval,
        reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      },
    ]);
    expect(getPendingControlRequests(runtime.listener, scope)).toHaveLength(0);
  });

  test("a sync that recovers only stale denials sends them as a turn immediately", async () => {
    const runtime = createScopedRuntime();
    const transport = connectRuntime(runtime);
    const processed: Array<{
      message: IncomingMessage;
      hadLease: boolean;
      connectionId: string | undefined;
    }> = [];

    await replaySyncStateForRuntime(
      runtime.listener,
      transport as never,
      scope,
      {
        recoverApprovals: false,
        forceDeviceStatus: true,
        connectionId: "cloud-relay",
        recoverApprovalStateForSync: async (scopedRuntime, recoveredScope) => {
          await recoverApprovalStateForSync(
            scopedRuntime,
            recoveredScope,
            createDeps([bashApproval]),
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
          connectionId,
          _batchId,
          turnLease,
        ) => {
          processed.push({
            message,
            hadLease: turnLease !== undefined,
            connectionId,
          });
          if (turnLease)
            ownerRuntime.turnLifecycle.finish(turnLease, "end_turn");
        },
      },
    );

    // The continuation owns the lifecycle before the status replay runs, so
    // the first sync already reports an active turn instead of idle.
    const statusFrames = transport.sent
      .map((payload) => JSON.parse(payload))
      .filter((frame) => frame.type === "update_loop_status");
    expect(statusFrames.length).toBeGreaterThan(0);
    expect(statusFrames[0]?.status).not.toBe("WAITING_ON_INPUT");

    await waitFor(() => processed.length === 1);
    const [turn] = processed;
    expect(turn?.hadLease).toBe(true);
    expect(turn?.connectionId).toBe("cloud-relay");
    expect(turn?.message.messages).toHaveLength(1);
    expect(turn?.message.messages[0]).toMatchObject({
      type: "approval",
      approvals: [
        {
          type: "approval",
          tool_call_id: "call-bash-1",
          approve: false,
          reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
        },
      ],
    });
    await waitFor(() => runtime.recoveredApprovalState === null);
    expect(runtime.pendingInterruptedResults).toBeNull();
    expect(runtime.syncApprovalRecoveryCompleted).toBe(true);
  });

  test("the first sync recovers even when the server sends recover_approvals=false", async () => {
    const runtime = createScopedRuntime();
    const transport = connectRuntime(runtime);
    let recoveryCalls = 0;
    const recover = async () => {
      recoveryCalls += 1;
    };

    // Post-restart readiness probes and activity-claim syncs always send
    // false; the first one for a scope must still consult the backend.
    await replaySyncStateForRuntime(
      runtime.listener,
      transport as never,
      scope,
      {
        recoverApprovals: false,
        recoverApprovalStateForSync: recover,
      },
    );
    expect(recoveryCalls).toBe(1);
    expect(runtime.syncApprovalRecoveryCompleted).toBe(true);

    transport.sent.length = 0;
    await replaySyncStateForRuntime(
      runtime.listener,
      transport as never,
      scope,
      {
        recoverApprovals: false,
        forceDeviceStatus: true,
        recoverApprovalStateForSync: recover,
      },
    );
    expect(recoveryCalls).toBe(1);
    // The lightweight path still replays in-memory state to the connection.
    expect(transport.sent.map((payload) => JSON.parse(payload).type)).toEqual([
      "update_device_status",
      "update_loop_status",
      "update_queue",
      "update_subagent_state",
    ]);

    await replaySyncStateForRuntime(
      runtime.listener,
      transport as never,
      scope,
      {
        recoverApprovals: true,
        recoverApprovalStateForSync: recover,
      },
    );
    expect(recoveryCalls).toBe(2);
  });

  test("a failed first recovery pass retries on the next lightweight sync", async () => {
    const runtime = createScopedRuntime();
    const transport = connectRuntime(runtime);
    let recoveryCalls = 0;

    await replaySyncStateForRuntime(
      runtime.listener,
      transport as never,
      scope,
      {
        recoverApprovals: false,
        recoverApprovalStateForSync: async () => {
          recoveryCalls += 1;
          throw new Error("backend unavailable");
        },
      },
    );
    expect(recoveryCalls).toBe(1);
    expect(runtime.syncApprovalRecoveryCompleted).toBe(false);

    await replaySyncStateForRuntime(
      runtime.listener,
      transport as never,
      scope,
      {
        recoverApprovals: false,
        recoverApprovalStateForSync: async () => {
          recoveryCalls += 1;
        },
      },
    );
    expect(recoveryCalls).toBe(2);
    expect(runtime.syncApprovalRecoveryCompleted).toBe(true);
  });

  test("mixed batch re-presents interactive tools and stages denials for the rest", async () => {
    const runtime = createScopedRuntime();

    await recoverApprovalStateForSync(
      runtime,
      scope,
      createDeps([bashApproval, askUserQuestionApproval]),
    );

    expect(runtime.pendingInterruptedResults).toBeNull();
    const recovered = runtime.recoveredApprovalState;
    expect(recovered?.pendingRequestIds).toEqual(new Set(["perm-call-ask-1"]));
    expect(recovered?.autoDecisions).toEqual([
      {
        type: "deny",
        approval: bashApproval,
        reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      },
    ]);

    const pending = getPendingControlRequests(runtime.listener, scope);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.request.tool_name).toBe("AskUserQuestion");
  });

  test("a repeat sync keeps the in-flight recovered state object", async () => {
    const runtime = createScopedRuntime();
    const deps = createDeps([askUserQuestionApproval]);

    await recoverApprovalStateForSync(runtime, scope, deps);
    const firstRecovered = runtime.recoveredApprovalState;
    expect(firstRecovered).not.toBeNull();

    await recoverApprovalStateForSync(runtime, scope, deps);
    expect(runtime.recoveredApprovalState).toBe(firstRecovered);
  });

  test("recovered state with no unanswered requests clears when the backend is idle", async () => {
    const runtime = createScopedRuntime();

    await recoverApprovalStateForSync(
      runtime,
      scope,
      createDeps([askUserQuestionApproval]),
    );
    expect(runtime.recoveredApprovalState).not.toBeNull();

    // All requests answered: the keep-in-flight guard no longer applies, so a
    // sync against an idle backend clears the leftover state.
    runtime.recoveredApprovalState?.pendingRequestIds.clear();

    await recoverApprovalStateForSync(runtime, scope, createDeps([]));
    expect(runtime.recoveredApprovalState).toBeNull();
    expect(getPendingControlRequests(runtime.listener, scope)).toHaveLength(0);
  });

  test("sync wiring denies recovered stale approvals and never auto-runs them", () => {
    const recoveryPath = fileURLToPath(
      new URL("./recovery-sync.ts", import.meta.url),
    );
    const source = readFileSync(recoveryPath, "utf-8");

    // Replay-unsafe tools become stale denials; interactive tools are
    // re-presented as recovered control requests (LET-10821). Neither path
    // may classify or auto-execute restored approvals (#1876). The denials
    // ride on recovered state as deny decisions; the sync caller sends them
    // as the next turn, and nothing here approves or runs a restored tool.
    expect(source).toContain('type: "deny" as const,');
    expect(source).toContain("STALE_APPROVAL_RECOVERY_DENIAL_REASON");
    expect(source).not.toContain('type: "approve"');
    expect(source).toContain("clearRecoveredApprovalState(runtime);");
    expect(source).toContain("isInteractiveApprovalTool");
    expect(source).not.toContain("classifyApprovalsWithSuggestions(");
    expect(source).not.toContain("buildRecoveredAutoDecisions(");
    expect(source).not.toContain("executeApprovalBatch");
  });
});
