import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetCompletedSubagentRetentionMsForTests,
  __setCompletedSubagentRetentionMsForTests,
  __setPublishedResultRetentionMsForTests,
  clearAllSubagents,
  clearCompletedSubagents,
  completeSubagent,
  getSubagentByToolCallId,
  getSubagentLifecycleContext,
  registerSubagent,
  updateSubagent,
} from "@/agent/subagent-state";

describe("subagentState retention", () => {
  afterEach(() => {
    __resetCompletedSubagentRetentionMsForTests();
    clearAllSubagents();
  });

  test("completed subagents age out automatically", async () => {
    __setCompletedSubagentRetentionMsForTests(20);

    registerSubagent(
      "sub-1",
      "general-purpose",
      "Find symbols",
      "tc-task",
      false,
    );
    completeSubagent("sub-1", { success: true });

    expect(getSubagentByToolCallId("tc-task")).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(getSubagentByToolCallId("tc-task")).toBeUndefined();
  });

  test("published results outlive ordinary retention for a reconnecting caller", async () => {
    __setCompletedSubagentRetentionMsForTests(20);
    __setPublishedResultRetentionMsForTests(200);

    registerSubagent("sub-remote", "claude-code", "Review", "tc-remote", true);
    completeSubagent("sub-remote", { success: true, result: "report" });
    clearCompletedSubagents();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(getSubagentByToolCallId("tc-remote")?.result).toBe("report");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(getSubagentByToolCallId("tc-remote")).toBeUndefined();
  });

  test("lifecycle context exposes normalized subagent state", () => {
    registerSubagent(
      "sub-reflection",
      "reflection",
      "Dream about memory",
      "tc-reflection",
      true,
      true,
    );
    updateSubagent("sub-reflection", {
      agentId: "agent-reflection",
      agentURL: "https://chat.letta.com/agents/agent-reflection",
    });

    expect(getSubagentLifecycleContext().list()).toMatchObject([
      {
        id: "sub-reflection",
        type: "Reflection",
        description: "Dream about memory",
        status: "running",
        agentId: "agent-reflection",
        agentUrl: "https://chat.letta.com/agents/agent-reflection",
        isBackground: true,
        visibleInTranscript: false,
      },
    ]);
    expect(
      getSubagentLifecycleContext().list()[0]?.elapsedMs,
    ).toBeGreaterThanOrEqual(0);
  });
});
