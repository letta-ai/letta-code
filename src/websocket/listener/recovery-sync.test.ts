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
  test("sync does not revive a legacy question as a control request", async () => {
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
      "update_device_status",
      "update_loop_status",
      "update_queue",
      "update_subagent_state",
    ]);
    expect(runtime.pendingInterruptedResults?.[0]).toMatchObject({
      tool_call_id: "call-ask-1",
      approve: false,
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
    expect(
      transport.sent.map((payload) => JSON.parse(payload).type),
    ).not.toContain("control_request");
  });

  test("a legacy pending question follows the same stale-denial path as other calls", async () => {
    const runtime = createScopedRuntime();

    await recoverApprovalStateForSync(
      runtime,
      scope,
      createDeps([askUserQuestionApproval]),
    );

    expect(runtime.pendingInterruptedResults).toEqual([
      {
        type: "approval",
        tool_call_id: "call-ask-1",
        approve: false,
        reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      },
    ]);
    expect(runtime.recoveredApprovalState).toBeNull();
    expect(getPendingControlRequests(runtime.listener, scope)).toHaveLength(0);
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
          ensureModAdapters: async () => [],
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

  test("mixed batch stages stale denials for every interrupted call", async () => {
    const runtime = createScopedRuntime();

    await recoverApprovalStateForSync(
      runtime,
      scope,
      createDeps([bashApproval, askUserQuestionApproval]),
    );

    expect(runtime.pendingInterruptedResults).toEqual(
      [bashApproval, askUserQuestionApproval].map((approval) => ({
        type: "approval",
        tool_call_id: approval.toolCallId,
        approve: false,
        reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      })),
    );
    expect(getPendingControlRequests(runtime.listener, scope)).toHaveLength(0);
  });

  test("recovered state with no unanswered requests clears when the backend is idle", async () => {
    const runtime = createScopedRuntime();

    await recoverApprovalStateForSync(
      runtime,
      scope,
      createDeps([bashApproval]),
      { resumeInterruptedTurn: true },
    );
    expect(runtime.recoveredApprovalState).not.toBeNull();

    await recoverApprovalStateForSync(runtime, scope, createDeps([]));
    expect(runtime.recoveredApprovalState).toBeNull();
    expect(getPendingControlRequests(runtime.listener, scope)).toHaveLength(0);
  });

  test("sync wiring replays only explicitly unstarted approvals", () => {
    const recoveryPath = fileURLToPath(
      new URL("./recovery-sync.ts", import.meta.url),
    );
    const source = readFileSync(recoveryPath, "utf-8");

    // Legacy/unrelated tools remain stale denials, while an explicit durable
    // unstarted marker is the only path which reconstructs an approval.
    expect(source).toContain('type: "deny" as const,');
    expect(source).toContain("STALE_APPROVAL_RECOVERY_DENIAL_REASON");
    expect(source).toContain("recorded.unstartedToolCallIds?.includes");
    expect(source).toContain('type: "approve" as const');
    expect(source).toContain("clearRecoveredApprovalState(runtime);");
    expect(source).not.toContain("isInteractiveApprovalTool");
    expect(source).not.toContain("classifyApprovalsWithSuggestions(");
    expect(source).not.toContain("buildRecoveredAutoDecisions(");
    expect(source).not.toContain("executeApprovalBatch");
  });
});
