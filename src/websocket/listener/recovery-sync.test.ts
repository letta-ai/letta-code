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
import { createRuntime } from "./lifecycle";
import { recoverApprovalStateForSync } from "./recovery-sync";
import { getPendingControlRequests } from "./runtime";
import { replaySyncStateForRuntime } from "./sync-replay";
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

  test("owner sync with only stale denials holds them for an immediate turn", async () => {
    const runtime = createScopedRuntime();
    // Auto-allowable, manual, and auto-deniable tools all become stale
    // denials: nothing is classified, re-run, or re-asked (#1876).
    const stale = [
      { toolCallId: "call-read-1", toolName: "Read", toolArgs: "{}" },
      bashApproval,
      { toolCallId: "call-write-1", toolName: "Write", toolArgs: "{}" },
    ];

    await recoverApprovalStateForSync(runtime, scope, createDeps(stale), {
      resumeInterruptedTurn: true,
    });

    // Nothing parks for a later user message: the sync caller sends these
    // denials as the next turn itself.
    expect(runtime.pendingInterruptedResults).toBeNull();
    expect(runtime.pendingInterruptedContext).toBeNull();
    const recovered = runtime.recoveredApprovalState;
    expect(recovered?.pendingRequestIds.size).toBe(0);
    expect(recovered?.approvalsByRequestId.size).toBe(0);
    expect(recovered?.autoDecisions).toEqual(
      stale.map((approval) => ({
        type: "deny",
        approval,
        reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      })),
    );
    expect(getPendingControlRequests(runtime.listener, scope)).toHaveLength(0);
  });

  test("observer sync with only stale denials parks them for this listener's next user message", async () => {
    const runtime = createScopedRuntime();

    // A browser attaching or a readiness probe: another process (a TUI,
    // `letta -p`, a different computer) may still be executing call-bash-1.
    await recoverApprovalStateForSync(
      runtime,
      scope,
      createDeps([bashApproval]),
    );

    expect(runtime.recoveredApprovalState).toBeNull();
    expect(runtime.pendingInterruptedResults).toEqual([
      {
        type: "approval",
        tool_call_id: "call-bash-1",
        approve: false,
        reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      },
    ]);
    expect(runtime.pendingInterruptedContext).toEqual({
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
      continuationEpoch: runtime.continuationEpoch,
    });
    expect(getPendingControlRequests(runtime.listener, scope)).toHaveLength(0);
  });

  test("an owner sync that recovers only stale denials sends them as a turn immediately", async () => {
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
          await recoverApprovalStateForSync(
            scopedRuntime,
            recoveredScope,
            createDeps([bashApproval]),
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
    expect(statusFrames[0]?.loop_status.status).not.toBe("WAITING_ON_INPUT");

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
  });

  test("an observer sync never starts a turn for another process's pending tool call", async () => {
    const runtime = createScopedRuntime();
    const transport = connectRuntime(runtime);
    const processed: IncomingMessage[] = [];

    // A browser attaches to a prewarmed sandbox (recover_approvals=true,
    // no resume_interrupted_turn) while `letta -p` on another machine is
    // still running call-bash-1.
    await replaySyncStateForRuntime(
      runtime.listener,
      transport as never,
      scope,
      {
        recoverApprovals: true,
        forceDeviceStatus: true,
        connectionId: "cloud-relay",
        recoverApprovalStateForSync: async (
          scopedRuntime,
          recoveredScope,
          _deps,
          recoverOpts,
        ) => {
          await recoverApprovalStateForSync(
            scopedRuntime,
            recoveredScope,
            createDeps([bashApproval]),
            recoverOpts,
          );
        },
        processIncomingMessage: async (message) => {
          processed.push(message);
        },
      },
    );
    await Bun.sleep(5);

    expect(processed).toHaveLength(0);
    expect(runtime.isProcessing).toBe(false);
    expect(runtime.recoveredApprovalState).toBeNull();
    expect(runtime.pendingInterruptedResults).toEqual([
      {
        type: "approval",
        tool_call_id: "call-bash-1",
        approve: false,
        reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      },
    ]);
    const statusFrames = transport.sent
      .map((payload) => JSON.parse(payload))
      .filter((frame) => frame.type === "update_loop_status");
    expect(statusFrames.length).toBeGreaterThan(0);
    expect(statusFrames[0]?.loop_status.status).toBe("WAITING_ON_INPUT");
  });

  test("recover_approvals=false never consults the backend, even on the first sync", async () => {
    const runtime = createScopedRuntime();
    const transport = connectRuntime(runtime);
    let recoveryCalls = 0;
    const recover = async () => {
      recoveryCalls += 1;
    };

    // cloud-api's readiness probes and activity claims send false. A fresh
    // listener (a prewarmed sandbox) must not touch a conversation it only
    // observes; the relaunch path asks explicitly with recover_approvals=true.
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
    expect(recoveryCalls).toBe(0);
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
    expect(recoveryCalls).toBe(1);
  });

  test("deferred ownership lookup retries on the next recovering sync without a timer", async () => {
    const runtime = createScopedRuntime();
    const transport = connectRuntime(runtime);
    let calls = 0;
    const recover = async () => {
      calls += 1;
      return calls === 1 ? "deferred" : undefined;
    };
    await replaySyncStateForRuntime(
      runtime.listener,
      transport as never,
      scope,
      { recoverApprovals: true, recoverApprovalStateForSync: recover },
    );
    expect(calls).toBe(1);
    await replaySyncStateForRuntime(
      runtime.listener,
      transport as never,
      scope,
      { recoverApprovals: true, recoverApprovalStateForSync: recover },
    );
    expect(calls).toBe(2);
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
