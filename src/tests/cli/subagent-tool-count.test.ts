import { beforeEach, describe, expect, test } from "bun:test";
import type { Line } from "../../cli/helpers/accumulator";
import {
  collectFinishedTaskToolCalls,
  createSubagentGroupItem,
} from "../../cli/helpers/subagentAggregation";
import {
  addToolCall,
  clearAllSubagents,
  completeSubagent,
  getSubagentByToolCallId,
  getSubagentToolCount,
  registerSubagent,
  updateSubagent,
} from "../../cli/helpers/subagentState";

describe("subagent tool count stability", () => {
  beforeEach(() => {
    clearAllSubagents();
  });

  test("tool count remains monotonic even if toolCalls array is overwritten with fewer entries", () => {
    registerSubagent(
      "sub-1",
      "general-purpose",
      "Find symbols",
      "tc-task",
      false,
    );
    addToolCall("sub-1", "tc-read", "Read", "{}");
    addToolCall("sub-1", "tc-grep", "Grep", "{}");

    const before = getSubagentByToolCallId("tc-task");
    if (!before) {
      throw new Error("Expected subagent for tc-task");
    }
    expect(getSubagentToolCount(before)).toBe(2);

    // Simulate a stale overwrite (should not reduce displayed count).
    updateSubagent("sub-1", {
      toolCalls: before.toolCalls.slice(0, 1),
    });

    const after = getSubagentByToolCallId("tc-task");
    if (!after) {
      throw new Error("Expected updated subagent for tc-task");
    }
    expect(after.toolCalls.length).toBe(1);
    expect(getSubagentToolCount(after)).toBe(2);

    completeSubagent("sub-1", { success: true });
    const completed = getSubagentByToolCallId("tc-task");
    if (!completed) {
      throw new Error("Expected completed subagent for tc-task");
    }
    expect(getSubagentToolCount(completed)).toBe(2);
  });

  test("static subagent grouping uses monotonic tool count", () => {
    registerSubagent(
      "sub-1",
      "general-purpose",
      "Find symbols",
      "tc-task",
      false,
    );
    addToolCall("sub-1", "tc-read", "Read", "{}");
    addToolCall("sub-1", "tc-grep", "Grep", "{}");
    completeSubagent("sub-1", { success: true, totalTokens: 42 });

    const subagent = getSubagentByToolCallId("tc-task");
    if (!subagent) {
      throw new Error("Expected subagent for tc-task before grouping");
    }

    // Simulate stale reduction right before grouping.
    updateSubagent("sub-1", {
      toolCalls: subagent.toolCalls.slice(0, 1),
    });

    const order = ["line-task"];
    const byId = new Map<string, Line>([
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

    const finished = collectFinishedTaskToolCalls(
      order,
      byId,
      new Set<string>(),
      false,
    );
    expect(finished.length).toBe(1);

    const group = createSubagentGroupItem(finished);
    expect(group.agents.length).toBe(1);
    expect(group.agents[0]?.toolCount).toBe(2);
  });
});
