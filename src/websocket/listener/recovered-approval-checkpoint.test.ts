import { expect, test } from "bun:test";
import {
  type ApprovalResult,
  settleApprovalExecutionTasks,
} from "@/agent/approval-execution";
import {
  createRecoveredApprovalEffectBoundary,
  RECOVERED_APPROVAL_OUTCOME_UNKNOWN,
  recoveredApprovalFailureResults,
  recoveredApprovalInFlightResults,
} from "./recovered-approval-checkpoint";

test("pre-effect claim loss never checkpoints an unknown outcome", () => {
  const owned = false;
  let checkpoints = 0;
  const boundary = createRecoveredApprovalEffectBoundary({
    ownsClaim: () => owned,
    checkpointUnknown: () => {
      checkpoints += 1;
    },
    onCrossed: () => {},
  });
  expect(() => boundary.beforeToolExecution()).toThrow(
    "Recovery claim lost before tool execution",
  );
  expect(checkpoints).toBe(0);
  expect(boundary.claimLost).toBe(true);
});

test("parallel boundary failure waits for an already-started effect", async () => {
  let owned = true;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const decisions = [
    {
      type: "approve" as const,
      approval: { toolCallId: "call-a", toolName: "Read", toolArgs: "{}" },
    },
    {
      type: "approve" as const,
      approval: { toolCallId: "call-b", toolName: "Read", toolArgs: "{}" },
    },
  ];
  let evidence = recoveredApprovalInFlightResults([]);
  const completed: ApprovalResult[] = [];
  let firstStarted = false;
  let secondStarted = false;
  const boundary = createRecoveredApprovalEffectBoundary({
    ownsClaim: () => owned,
    checkpointUnknown: () => {
      evidence = recoveredApprovalInFlightResults(decisions);
    },
    onCrossed: () => {},
  });

  const first = (async () => {
    boundary.beforeToolExecution();
    firstStarted = true;
    await firstBlocked;
    completed.push({
      type: "tool",
      tool_call_id: "call-a",
      status: "success",
      tool_return: "effect-a-completed",
    });
  })();
  owned = false;
  const second = (async () => {
    boundary.beforeToolExecution();
    secondStarted = true;
  })();
  const settled = settleApprovalExecutionTasks(
    [first, second],
    () => completed,
  );
  let batchSettled = false;
  void settled.then(
    () => {
      batchSettled = true;
    },
    () => {
      batchSettled = true;
    },
  );
  await Promise.resolve();

  expect(firstStarted).toBe(true);
  expect(secondStarted).toBe(false);
  expect(batchSettled).toBe(false);
  expect(evidence).toEqual([
    expect.objectContaining({
      tool_call_id: "call-a",
      tool_return: RECOVERED_APPROVAL_OUTCOME_UNKNOWN,
    }),
    expect.objectContaining({
      tool_call_id: "call-b",
      tool_return: RECOVERED_APPROVAL_OUTCOME_UNKNOWN,
    }),
  ]);

  releaseFirst();
  let finalEvidence: ApprovalResult[] = [];
  try {
    await settled;
  } catch (error) {
    finalEvidence = recoveredApprovalFailureResults(decisions, error);
  }
  expect(batchSettled).toBe(true);
  expect(finalEvidence).toEqual([
    expect.objectContaining({
      tool_call_id: "call-a",
      tool_return: "effect-a-completed",
    }),
    expect.objectContaining({
      tool_call_id: "call-b",
      tool_return: expect.stringContaining(
        "Recovery claim lost before tool execution",
      ),
    }),
  ]);
});

test("hard-death checkpoint distinguishes unknown execution from denial", () => {
  const approval = {
    toolCallId: "call-approved",
    toolName: "Bash",
    toolArgs: '{"command":"deploy"}',
  };
  expect(
    recoveredApprovalInFlightResults([
      { type: "approve", approval },
      {
        type: "deny",
        approval: { ...approval, toolCallId: "call-denied" },
        reason: "policy",
      },
    ]),
  ).toEqual([
    {
      type: "tool",
      tool_call_id: "call-approved",
      status: "error",
      tool_return: RECOVERED_APPROVAL_OUTCOME_UNKNOWN,
    },
    {
      type: "approval",
      tool_call_id: "call-denied",
      approve: false,
      reason: "policy",
    },
  ]);
});
