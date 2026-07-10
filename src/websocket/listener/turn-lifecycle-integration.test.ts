import { describe, expect, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { getOrCreateConversationPermissionModeStateRef } from "./permission-mode";
import { shouldProcessInboundMessageDirectly } from "./queue";
import { finalizeHandledRecoveryTurn } from "./recovery";
import { clearConversationRuntimeState } from "./runtime";
import type { ListenerTransport } from "./transport";
import { handleApprovalStop } from "./turn-approval";
import type { TurnLease } from "./turn-lifecycle";

function createOpenTransport(sentPayloads: string[] = []): ListenerTransport {
  return {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: (payload: string) => sentPayloads.push(payload),
  };
}

async function waitForPendingApproval(
  runtime: ReturnType<typeof getOrCreateScopedRuntime>,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (runtime.pendingApprovalResolvers.size > 0) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Approval request was not registered");
}

function startQuestionApproval(
  runtime: ReturnType<typeof getOrCreateScopedRuntime>,
  turnLease: TurnLease,
) {
  return handleApprovalStop({
    approvals: [
      {
        toolCallId: "call-1",
        toolName: "AskUserQuestion",
        toolArgs: JSON.stringify({
          questions: [
            {
              question: "Continue?",
              header: "Confirm",
              options: [
                { label: "Yes", description: "Continue the turn" },
                { label: "No", description: "Stop the turn" },
              ],
              multiSelect: false,
            },
          ],
        }),
      },
    ],
    runtime,
    socket: createOpenTransport(),
    agentId: "agent-1",
    conversationId: "conv-1",
    turnWorkingDirectory: process.cwd(),
    turnPermissionModeState: getOrCreateConversationPermissionModeStateRef(
      runtime.listener,
      "agent-1",
      "conv-1",
    ),
    dequeuedBatchId: "batch-1",
    msgRunIds: [],
    currentInput: [],
    pendingNormalizationInterruptedToolCallIds: [],
    turnToolContextId: null,
    turnLease,
    buildSendOptions: () =>
      ({
        agentId: "agent-1",
        streamTokens: true,
        background: true,
        workingDirectory: process.cwd(),
      }) as never,
  });
}

describe("listener turn lifecycle integration", () => {
  test("disconnect cleanup during a live approval cannot leave stale processing ownership", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const turnLease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
      initialStatus: "PROCESSING_API_RESPONSE",
    });

    const approvalResultPromise = startQuestionApproval(runtime, turnLease);

    await waitForPendingApproval(runtime);
    clearConversationRuntimeState(runtime);

    const approvalResult = await approvalResultPromise;
    expect(approvalResult.kind).toBe("interrupted");
    expect(turnLease.signal.aborted).toBe(true);
    expect(runtime.turnLifecycle.kind).toBe("idle");
    expect(runtime.isProcessing).toBe(false);
    expect(runtime.cancelRequested).toBe(false);
    expect(runtime.loopStatus).toBe("WAITING_ON_INPUT");
    expect(runtime.activeRunId).toBeNull();
    expect(runtime.turnLifecycle.currentLease).toBeNull();
    expect(runtime.pendingApprovalResolvers.size).toBe(0);

    expect(
      shouldProcessInboundMessageDirectly(runtime, {
        type: "message",
        agentId: "agent-1",
        conversationId: "conv-1",
        messages: [{ role: "user", content: "follow up" }],
      }),
    ).toBe(true);
  });

  test("an old approval unwind cannot mutate a replacement turn", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const staleLease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
      initialStatus: "PROCESSING_API_RESPONSE",
    });
    const approvalResultPromise = startQuestionApproval(runtime, staleLease);

    await waitForPendingApproval(runtime);
    clearConversationRuntimeState(runtime);
    const replacementLease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });

    expect((await approvalResultPromise).kind).toBe("interrupted");
    expect(runtime.turnLifecycle.isCurrent(replacementLease)).toBe(true);
    expect(runtime.turnLifecycle.kind).toBe("active");
    expect(runtime.isProcessing).toBe(true);
  });

  test("a stale recovery owner cannot finish or report errors for its replacement", () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const staleLease = runtime.turnLifecycle.begin({
      origin: "approval_recovery",
      workingDirectory: process.cwd(),
    });

    clearConversationRuntimeState(runtime);
    const replacementLease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    const sentPayloads: string[] = [];

    const transition = finalizeHandledRecoveryTurn(
      runtime,
      createOpenTransport(sentPayloads),
      staleLease,
      {
        drainResult: { stopReason: "error" } as never,
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    );

    expect(transition.finished).toBe(false);
    expect(runtime.turnLifecycle.isCurrent(replacementLease)).toBe(true);
    expect(runtime.turnLifecycle.kind).toBe("active");
    expect(sentPayloads).toEqual([]);
  });
});
