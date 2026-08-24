import { describe, expect, test } from "bun:test";
import { STALE_APPROVAL_RECOVERY_DENIAL_REASON } from "@/agent/turn-recovery-policy";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime, replaySyncStateForRuntime } from "./lifecycle";
import { recoverApprovalStateForSync } from "./recovery-sync";
import { getPendingControlRequests } from "./runtime";
import type { LocalTransport } from "./transport";
import type { ConversationRuntime, StartListenerOptions } from "./types";

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

  test("still stages stale denials when no pending approval is interactive", async () => {
    const runtime = createScopedRuntime();

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
    expect(getPendingControlRequests(runtime.listener, scope)).toHaveLength(0);
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
});
