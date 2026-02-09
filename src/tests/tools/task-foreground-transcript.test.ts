import { beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

const mockSpawnSubagent = mock(
  async (): Promise<{
    agentId: string;
    conversationId: string;
    report: string;
    success: boolean;
    totalTokens?: number;
    error?: string;
  }> => ({
    agentId: "agent-123",
    conversationId: "conversation-123",
    report: "subagent report",
    success: true,
    totalTokens: 42,
  }),
);

const mockRegisterSubagent = mock(() => {});
const mockCompleteSubagent = mock(() => {});

const originalAgentSubagents = await import("../../agent/subagents");
const originalMessageQueueBridge = await import(
  "../../cli/helpers/messageQueueBridge.js"
);
const originalSubagentState = await import(
  "../../cli/helpers/subagentState.js"
);

mock.module("../../agent/subagents", () => ({
  ...originalAgentSubagents,
  discoverSubagents: async () => ({ subagents: [], errors: [] }),
  getAllSubagentConfigs: async () => ({
    explore: { recommendedModel: "inherit" },
    "general-purpose": { recommendedModel: "inherit" },
  }),
}));

mock.module("../../agent/subagents/manager", () => ({
  spawnSubagent: mockSpawnSubagent,
}));

mock.module("../../cli/helpers/messageQueueBridge.js", () => ({
  ...originalMessageQueueBridge,
  addToMessageQueue: () => {},
}));

mock.module("../../cli/helpers/subagentState.js", () => ({
  ...originalSubagentState,
  generateSubagentId: () => "subagent-1",
  registerSubagent: mockRegisterSubagent,
  completeSubagent: mockCompleteSubagent,
  addToolCall: () => {},
  updateSubagent: () => {},
  getSnapshot: () => ({ agents: [] }),
}));

describe("Task foreground transcript output", () => {
  beforeEach(() => {
    mockSpawnSubagent.mockReset();
    mockRegisterSubagent.mockClear();
    mockCompleteSubagent.mockClear();
  });

  test("returns output file path and writes full transcript on success", async () => {
    mockSpawnSubagent.mockResolvedValueOnce({
      agentId: "agent-abc",
      conversationId: "conversation-abc",
      report: "full success report",
      success: true,
      totalTokens: 7,
    });

    const { task } = await import("../../tools/impl/Task");
    const output = await task({
      subagent_type: "explore",
      prompt: "Investigate",
      description: "foreground success",
    });

    expect(output).toContain("Output file:");
    expect(output).toContain("subagent_type=explore");

    const match = output.match(/Output file: (.+)$/m);
    expect(match?.[1]).toBeTruthy();
    const outputFile = match?.[1] as string;

    expect(existsSync(outputFile)).toBe(true);
    const content = readFileSync(outputFile, "utf-8");
    expect(content).toContain("[Task started: foreground success]");
    expect(content).toContain("subagent_type=explore");
    expect(content).toContain("full success report");
    expect(content).toContain("[Task completed]");

    unlinkSync(outputFile);
  });

  test("returns output file path and writes failure transcript on error", async () => {
    mockSpawnSubagent.mockResolvedValueOnce({
      agentId: "agent-def",
      conversationId: "conversation-def",
      report: "",
      success: false,
      error: "Maximum turns limit reached (1/1 steps)",
    });

    const { task } = await import("../../tools/impl/Task");
    const output = await task({
      subagent_type: "explore",
      prompt: "Investigate",
      description: "foreground failure",
    });

    expect(output).toContain("Error:");
    expect(output).toContain("Maximum turns limit reached (1/1 steps)");
    expect(output).toContain("Output file:");

    const match = output.match(/Output file: (.+)$/m);
    expect(match?.[1]).toBeTruthy();
    const outputFile = match?.[1] as string;

    expect(existsSync(outputFile)).toBe(true);
    const content = readFileSync(outputFile, "utf-8");
    expect(content).toContain("[Task started: foreground failure]");
    expect(content).toContain(
      "[error] Maximum turns limit reached (1/1 steps)",
    );
    expect(content).toContain("[Task failed]");

    unlinkSync(outputFile);
  });
});
