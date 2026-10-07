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

test("pre-effect claim loss leaves an approved tool replayable", async () => {
  let checkpoints = 0;
  const boundary = createRecoveredApprovalEffectBoundary({
    decisions: [decisions[0] as (typeof decisions)[number]],
    ownsClaim: () => false,
    checkpoint: () => {
      checkpoints += 1;
    },
    onCrossed: () => {},
  });
  await expect(boundary.beforeToolExecution("call-a")).rejects.toThrow(
    "Recovery claim lost before tool execution",
  );
  expect(checkpoints).toBe(0);
  expect(boundary.results).toEqual([]);
  expect(boundary.claimLost).toBe(true);
});

test("authority loss during a failed pre-effect checkpoint restores unstarted state", async () => {
  let owned = true;
  const boundary = createRecoveredApprovalEffectBoundary({
    decisions: [decisions[0] as (typeof decisions)[number]],
    ownsClaim: () => owned,
    checkpoint: async () => {
      owned = false;
      throw new Error("Interrupted durable write lost authority before commit");
    },
    onCrossed: () => {},
  });

  await expect(boundary.beforeToolExecution("call-a")).rejects.toThrow(
    "lost authority",
  );
  expect(boundary.claimLost).toBe(true);
  expect(boundary.crossed).toBe(false);
  expect(boundary.results).toEqual([]);
  expect(boundary.unstartedToolCallIds).toEqual(["call-a"]);
});

test("parallel pre-effect checkpoints cannot snapshot state before rollback", async () => {
  let rejectFirst!: (error: Error) => void;
  const firstCheckpoint = new Promise<void>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const snapshots: Array<{
    results: ApprovalResult[];
    unstarted: string[];
  }> = [];
  const boundary = createRecoveredApprovalEffectBoundary({
    decisions,
    ownsClaim: () => true,
    checkpoint: (results, unstarted) => {
      snapshots.push({
        results: structuredClone(results),
        unstarted: [...unstarted],
      });
      return snapshots.length === 1 ? firstCheckpoint : undefined;
    },
    onCrossed: () => {},
  });

  const first = boundary.beforeToolExecution("call-a");
  const firstOutcome = first.catch((error: unknown) => error);
  while (snapshots.length === 0) await Bun.sleep(0);
  const second = boundary.beforeToolExecution("call-b");
  await Bun.sleep(0);
  expect(snapshots).toHaveLength(1);

  rejectFirst(new Error("checkpoint failed"));
  expect(await firstOutcome).toEqual(
    expect.objectContaining({ message: "checkpoint failed" }),
  );
  await second;

  expect(snapshots).toHaveLength(2);
  expect(snapshots[1]?.results).toEqual([
    expect.objectContaining({ tool_call_id: "call-b" }),
  ]);
  expect(snapshots[1]?.unstarted).toEqual(["call-a"]);
});

test("exact sibling result waits for a rejecting pre-effect rollback", async () => {
  let owned = true;
  let rejectSecond!: (error: Error) => void;
  const secondCheckpoint = new Promise<void>((_resolve, reject) => {
    rejectSecond = reject;
  });
  const snapshots: Array<{
    results: ApprovalResult[];
    unstarted: string[];
    phase: "before" | "after";
  }> = [];
  const boundary = createRecoveredApprovalEffectBoundary({
    decisions,
    ownsClaim: () => owned,
    checkpoint: (results, unstarted, phase) => {
      snapshots.push({
        results: structuredClone(results),
        unstarted: [...unstarted],
        phase,
      });
      return snapshots.length === 2 ? secondCheckpoint : undefined;
    },
    onCrossed: () => {},
  });

  await boundary.beforeToolExecution("call-a");
  const second = boundary.beforeToolExecution("call-b");
  const secondOutcome = second.catch((error: unknown) => error);
  while (snapshots.length < 2) await Bun.sleep(0);
  const exactResult: ApprovalResult = {
    type: "tool",
    tool_call_id: "call-a",
    status: "success",
    tool_return: "done-a",
  };
  const afterFirst = boundary.afterToolExecution("call-a", exactResult);
  await Bun.sleep(0);
  expect(snapshots).toHaveLength(2);

  owned = false;
  rejectSecond(new Error("claim lost while checkpointing call-b"));
  expect(await secondOutcome).toEqual(
    expect.objectContaining({
      message: "claim lost while checkpointing call-b",
    }),
  );
  await afterFirst;

  expect(boundary.claimLost).toBe(true);
  expect(snapshots[2]).toEqual({
    results: [exactResult],
    unstarted: ["call-b"],
    phase: "after",
  });
});

test("serial checkpoints leave a not-yet-started sibling replayable", async () => {
  const checkpoints: ApprovalResult[][] = [];
  const boundary = createRecoveredApprovalEffectBoundary({
    decisions,
    ownsClaim: () => true,
    checkpoint: (results) => {
      checkpoints.push(structuredClone(results));
    },
    onCrossed: () => {},
  });
  await boundary.beforeToolExecution("call-a");
  await boundary.afterToolExecution("call-a", {
    type: "tool",
    tool_call_id: "call-a",
    status: "success",
    tool_return: "done-a",
  });

  expect(checkpoints[0]).toEqual([
    expect.objectContaining({
      tool_call_id: "call-a",
      tool_return: RECOVERED_APPROVAL_OUTCOME_UNKNOWN,
    }),
  ]);
  expect(checkpoints[1]).toEqual([
    expect.objectContaining({
      tool_call_id: "call-a",
      tool_return: "done-a",
    }),
  ]);
  expect(
    boundary.results.some((result) => result.tool_call_id === "call-b"),
  ).toBe(false);
});

test("initial checkpoint preserves precomputed effect evidence", () => {
  const boundary = createRecoveredApprovalEffectBoundary({
    decisions: [
      {
        type: "approve",
        approval: {
          toolCallId: "call-saved",
          toolName: "Write",
          toolArgs: "{}",
        },
        precomputedResult: {
          status: "success",
          toolReturn: "already completed",
        },
      },
      decisions[0] as (typeof decisions)[number],
    ],
    ownsClaim: () => true,
    checkpoint: () => {},
    onCrossed: () => {},
  });

  expect(boundary.initialResults).toEqual([
    expect.objectContaining({
      tool_call_id: "call-saved",
      status: "success",
      tool_return: "already completed",
    }),
  ]);
  expect(boundary.initialUnstartedToolCallIds).toEqual(["call-a"]);
});

test("parallel boundary failure waits for an already-started effect", async () => {
  let owned = true;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let evidence: ApprovalResult[] = [];
  const completed: ApprovalResult[] = [];
  let firstStarted = false;
  let secondStarted = false;
  const boundary = createRecoveredApprovalEffectBoundary({
    decisions,
    ownsClaim: () => owned,
    checkpoint: (results) => {
      evidence = structuredClone(results);
    },
    onCrossed: () => {},
  });

  const first = (async () => {
    await boundary.beforeToolExecution("call-a");
    firstStarted = true;
    await firstBlocked;
    const result: ApprovalResult = {
      type: "tool",
      tool_call_id: "call-a",
      status: "success",
      tool_return: "effect-a-completed",
    };
    completed.push(result);
    await boundary.afterToolExecution("call-a", result);
  })();
  while (!firstStarted) await Bun.sleep(0);
  owned = false;
  const second = (async () => {
    await boundary.beforeToolExecution("call-b");
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

  expect(firstStarted as boolean).toBe(true);
  expect(secondStarted).toBe(false);
  expect(batchSettled).toBe(false);
  expect(evidence).toEqual([
    expect.objectContaining({
      tool_call_id: "call-a",
      tool_return: RECOVERED_APPROVAL_OUTCOME_UNKNOWN,
    }),
  ]);

  releaseFirst();
  await expect(settled).rejects.toThrow(
    "Recovery claim lost before tool execution",
  );
  expect(batchSettled).toBe(true);
  expect(boundary.results).toEqual([
    expect.objectContaining({
      tool_call_id: "call-a",
      tool_return: "effect-a-completed",
    }),
  ]);
  expect(
    recoveredApprovalFailureResults(decisions, { partialResults: completed }),
  ).toEqual([expect.objectContaining({ tool_call_id: "call-a" })]);
});

test("initial checkpoint distinguishes denials and leaves approvals unstarted", () => {
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
      type: "approval",
      tool_call_id: "call-denied",
      approve: false,
      reason: "policy",
    },
  ]);
});
