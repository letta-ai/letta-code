import { describe, expect, test } from "bun:test";

import { isReflectionSubagentActive } from "../../cli/helpers/reflectionGate";

type Row = {
  type: string;
  status: "pending" | "running" | "completed" | "error";
  parentAgentId?: string;
  parentConversationId?: string;
};

describe("isReflectionSubagentActive", () => {
  test("returns false when no subagents are present", () => {
    expect(isReflectionSubagentActive([], "agent-me", "conv-me")).toBe(false);
  });

  test("ignores reflections scoped to a different parent agent", () => {
    // Regression for the global-gate bug: one stuck reflection on another
    // agent used to poison auto-launch for this agent.
    const rows: Row[] = [
      {
        type: "reflection",
        status: "pending",
        parentAgentId: "agent-other",
        parentConversationId: "conv-other",
      },
    ];
    expect(isReflectionSubagentActive(rows, "agent-me", "conv-me")).toBe(false);
  });

  test("ignores reflections scoped to a different conversation on the same agent", () => {
    const rows: Row[] = [
      {
        type: "reflection",
        status: "running",
        parentAgentId: "agent-me",
        parentConversationId: "conv-other",
      },
    ];
    expect(isReflectionSubagentActive(rows, "agent-me", "conv-me")).toBe(false);
  });

  test("detects a running reflection scoped to this agent + conversation", () => {
    const rows: Row[] = [
      {
        type: "reflection",
        status: "running",
        parentAgentId: "agent-me",
        parentConversationId: "conv-me",
      },
    ];
    expect(isReflectionSubagentActive(rows, "agent-me", "conv-me")).toBe(true);
  });

  test("detects a pending reflection scoped to this agent + conversation", () => {
    const rows: Row[] = [
      {
        type: "reflection",
        status: "pending",
        parentAgentId: "agent-me",
        parentConversationId: "conv-me",
      },
    ];
    expect(isReflectionSubagentActive(rows, "agent-me", "conv-me")).toBe(true);
  });

  test("ignores completed or errored reflections", () => {
    const rows: Row[] = [
      {
        type: "reflection",
        status: "completed",
        parentAgentId: "agent-me",
        parentConversationId: "conv-me",
      },
      {
        type: "reflection",
        status: "error",
        parentAgentId: "agent-me",
        parentConversationId: "conv-me",
      },
    ];
    expect(isReflectionSubagentActive(rows, "agent-me", "conv-me")).toBe(false);
  });

  test('treats missing parentConversationId as "default"', () => {
    const rows: Row[] = [
      {
        type: "reflection",
        status: "running",
        parentAgentId: "agent-me",
        parentConversationId: undefined,
      },
    ];
    expect(isReflectionSubagentActive(rows, "agent-me", "default")).toBe(true);
    expect(isReflectionSubagentActive(rows, "agent-me", "conv-me")).toBe(false);
  });

  test("ignores non-reflection subagent types", () => {
    const rows: Row[] = [
      {
        type: "explore",
        status: "running",
        parentAgentId: "agent-me",
        parentConversationId: "conv-me",
      },
      {
        type: "general-purpose",
        status: "running",
        parentAgentId: "agent-me",
        parentConversationId: "conv-me",
      },
    ];
    expect(isReflectionSubagentActive(rows, "agent-me", "conv-me")).toBe(false);
  });

  test("ignores reflections with no parentAgentId", () => {
    const rows: Row[] = [
      {
        type: "reflection",
        status: "running",
        parentAgentId: undefined,
        parentConversationId: "conv-me",
      },
    ];
    expect(isReflectionSubagentActive(rows, "agent-me", "conv-me")).toBe(false);
  });

  test("picks the in-scope reflection out of a mixed list", () => {
    const rows: Row[] = [
      {
        type: "reflection",
        status: "pending",
        parentAgentId: "agent-other",
        parentConversationId: "conv-other",
      },
      {
        type: "reflection",
        status: "running",
        parentAgentId: "agent-me",
        parentConversationId: "conv-me",
      },
      {
        type: "explore",
        status: "running",
        parentAgentId: "agent-me",
        parentConversationId: "conv-me",
      },
    ];
    expect(isReflectionSubagentActive(rows, "agent-me", "conv-me")).toBe(true);
  });
});
