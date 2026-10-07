import { describe, expect, mock, test } from "bun:test";
import { STALE_APPROVAL_RECOVERY_DENIAL_REASON } from "@/agent/turn-recovery-policy";
import { resolvePendingApprovalResolver } from "./approval";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { startRecoveredApprovalContinuation } from "./recovery";
import { clearConversationRuntimeState } from "./runtime";
import type { ListenerTransport } from "./transport";
import type { RecoveredApprovalState } from "./types";

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

describe("recovered approval lease boundaries", () => {
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
          prepareToolExecutionContext: async () => createPreparedToolContext(),
          executeApprovalBatch: async () => createDenialResults(),
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
  });

  test("recovered CodeMode executions forward nested approvals", async () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    runtime.recoveredApprovalState = createRecoveredState();
    let nestedDecision:
      | { approved: boolean; args?: Record<string, unknown> }
      | undefined;

    const handled = await startRecoveredApprovalContinuation(
      runtime,
      createTransport([]),
      async (_message, _socket, ownerRuntime, _s, _c, _b, turnLease) => {
        if (turnLease) ownerRuntime.turnLifecycle.finish(turnLease, "end_turn");
      },
      {
        dependencies: {
          ensureSecretsHydrated: async () => {},
          prepareToolExecutionContext: async () => createPreparedToolContext(),
          executeApprovalBatch: async (_decisions, _onChunk, options) => {
            const nested = options?.onNestedToolApproval?.({
              toolName: "Write",
              args: { file_path: "/tmp/nested" },
              toolCallId: "nested-call",
            });
            if (!nested) throw new Error("Missing nested approval callback");
            await waitFor(() => runtime.pendingApprovalResolvers.size > 0);
            const pending = [...runtime.pendingApprovalResolvers.values()][0];
            if (!pending) throw new Error("Missing nested approval");
            expect(pending.controlRequest?.request.tool_call_id).toBe(
              "nested-call",
            );
            resolvePendingApprovalResolver(runtime, {
              request_id: pending.requestId,
              decision: { behavior: "allow" },
            });
            nestedDecision = await nested;
            return createDenialResults();
          },
        },
      },
    );

    expect(handled).toBe(true);
    expect(nestedDecision?.approved).toBe(true);
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
