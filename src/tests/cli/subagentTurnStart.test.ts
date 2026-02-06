import { beforeEach, describe, expect, test } from "bun:test";
import {
  collectFinishedTaskToolCalls,
  hasInProgressTaskToolCalls,
} from "../../cli/helpers/subagentAggregation";
import {
  clearAllSubagents,
  clearCompletedSubagents,
  completeSubagent,
  getSubagentByToolCallId,
  registerSubagent,
} from "../../cli/helpers/subagentState";
import {
  flushEligibleLinesBeforeReentry,
  shouldClearCompletedSubagentsOnTurnStart,
} from "../../cli/helpers/subagentTurnStart";

type MinimalToolCallLine = {
  kind: "tool_call";
  id: string;
  name: string;
  phase: "finished";
  toolCallId: string;
  resultOk: boolean;
};

function simulateCommitPass(
  order: string[],
  byId: Map<string, MinimalToolCallLine>,
  emitted: Set<string>,
  deferredCommits: Map<string, number>,
  now: number,
  deferToolCalls: boolean,
): {
  blockedByDeferred: boolean;
  grouped: boolean;
  taskFallbackCommitted: boolean;
} {
  const hasInProgress = hasInProgressTaskToolCalls(
    order,
    byId as unknown as Map<string, never>,
    emitted,
  );
  const finishedTaskToolCalls = collectFinishedTaskToolCalls(
    order,
    byId as unknown as Map<string, never>,
    emitted,
    hasInProgress,
  );

  let blockedByDeferred = false;
  let taskFallbackCommitted = false;
  const TASK_DEFER_MS = 50;

  for (const id of order) {
    if (emitted.has(id)) continue;
    const ln = byId.get(id);
    if (!ln) continue;

    if (ln.name === "Task" || ln.name === "task") {
      const hasSubagentData = finishedTaskToolCalls.some(
        (tc) => tc.lineId === id,
      );
      if (!hasSubagentData) {
        emitted.add(id);
        taskFallbackCommitted = true;
      }
      continue;
    }

    if (deferToolCalls) {
      const commitAt = deferredCommits.get(id);
      if (commitAt === undefined) {
        deferredCommits.set(id, now + TASK_DEFER_MS);
        blockedByDeferred = true;
        break;
      }
      if (commitAt > now) {
        blockedByDeferred = true;
        break;
      }
      deferredCommits.delete(id);
    }

    emitted.add(id);
  }

  const grouped = !blockedByDeferred && finishedTaskToolCalls.length > 0;
  if (grouped) {
    for (const tc of finishedTaskToolCalls) {
      emitted.add(tc.lineId);
    }
  }

  return { blockedByDeferred, grouped, taskFallbackCommitted };
}

describe("subagent turn-start reentry safeguards", () => {
  beforeEach(() => {
    clearAllSubagents();
  });

  test("shouldClearCompletedSubagentsOnTurnStart preserves completed agents during allowReentry", () => {
    expect(shouldClearCompletedSubagentsOnTurnStart(true, false)).toBe(false);
    expect(shouldClearCompletedSubagentsOnTurnStart(false, false)).toBe(true);
    expect(shouldClearCompletedSubagentsOnTurnStart(false, true)).toBe(false);
  });

  test("deferred first pass + explicit pre-reentry flush preserves Task grouping", () => {
    registerSubagent("sub-1", "explore", "Find symbols", "tc-task", false);
    completeSubagent("sub-1", { success: true, totalTokens: 42 });

    const order = ["line-read", "line-task"];
    const byId = new Map<string, MinimalToolCallLine>([
      [
        "line-read",
        {
          kind: "tool_call",
          id: "line-read",
          name: "Read",
          phase: "finished",
          toolCallId: "tc-read",
          resultOk: true,
        },
      ],
      [
        "line-task",
        {
          kind: "tool_call",
          id: "line-task",
          name: "Task",
          phase: "finished",
          toolCallId: "tc-task",
          resultOk: true,
        },
      ],
    ]);
    const emitted = new Set<string>();
    const deferred = new Map<string, number>();

    // First commit pass gets blocked by deferred non-Task tool call.
    const first = simulateCommitPass(
      order,
      byId,
      emitted,
      deferred,
      1_000,
      true,
    );
    expect(first.blockedByDeferred).toBe(true);
    expect(first.grouped).toBe(false);
    expect(getSubagentByToolCallId("tc-task")).toBeDefined();

    // During reentry we should preserve completed subagents.
    if (shouldClearCompletedSubagentsOnTurnStart(true, false)) {
      clearCompletedSubagents();
    }
    expect(getSubagentByToolCallId("tc-task")).toBeDefined();

    // Explicit non-deferred flush before reentry should group Task instead of fallback.
    let flushed: ReturnType<typeof simulateCommitPass> | null = null;
    flushEligibleLinesBeforeReentry(() => {
      flushed = simulateCommitPass(
        order,
        byId,
        emitted,
        deferred,
        1_001,
        false,
      );
    }, {} as never);

    expect(flushed).not.toBeNull();
    expect(flushed?.blockedByDeferred).toBe(false);
    expect(flushed?.grouped).toBe(true);
    expect(flushed?.taskFallbackCommitted).toBe(false);
  });

  test("clearing completed agents before second pass reproduces Task fallback", () => {
    registerSubagent("sub-1", "explore", "Find symbols", "tc-task", false);
    completeSubagent("sub-1", { success: true });

    const order = ["line-read", "line-task"];
    const byId = new Map<string, MinimalToolCallLine>([
      [
        "line-read",
        {
          kind: "tool_call",
          id: "line-read",
          name: "Read",
          phase: "finished",
          toolCallId: "tc-read",
          resultOk: true,
        },
      ],
      [
        "line-task",
        {
          kind: "tool_call",
          id: "line-task",
          name: "Task",
          phase: "finished",
          toolCallId: "tc-task",
          resultOk: true,
        },
      ],
    ]);
    const emitted = new Set<string>();
    const deferred = new Map<string, number>();

    const first = simulateCommitPass(
      order,
      byId,
      emitted,
      deferred,
      2_000,
      true,
    );
    expect(first.blockedByDeferred).toBe(true);

    // This mirrors the old problematic behavior.
    clearCompletedSubagents();
    expect(getSubagentByToolCallId("tc-task")).toBeUndefined();

    const second = simulateCommitPass(
      order,
      byId,
      emitted,
      deferred,
      2_100,
      false,
    );
    expect(second.grouped).toBe(false);
    expect(second.taskFallbackCommitted).toBe(true);
  });
});
