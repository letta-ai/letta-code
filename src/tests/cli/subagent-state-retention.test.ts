import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetCompletedSubagentRetentionMsForTests,
  __setCompletedSubagentRetentionMsForTests,
  clearAllSubagents,
  completeSubagent,
  getSubagentByToolCallId,
  registerSubagent,
} from "../../cli/helpers/subagentState";

describe("subagentState retention", () => {
  afterEach(() => {
    __resetCompletedSubagentRetentionMsForTests();
    clearAllSubagents();
  });

  test("completed subagents age out automatically", async () => {
    __setCompletedSubagentRetentionMsForTests(20);

    registerSubagent("sub-1", "explore", "Find symbols", "tc-task", false);
    completeSubagent("sub-1", { success: true });

    expect(getSubagentByToolCallId("tc-task")).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(getSubagentByToolCallId("tc-task")).toBeUndefined();
  });
});
