import { describe, expect, test } from "bun:test";
import {
  buildCliModContext,
  calculateContextPercentages,
} from "@/cli/helpers/cli-mod-context";

describe("buildCliModContext", () => {
  test("builds mod context with all fields", () => {
    const context = buildCliModContext({
      modelId: "anthropic/claude-sonnet-4",
      modelDisplayName: "Sonnet",
      modelProvider: "anthropic",
      currentDirectory: "/repo",
      projectDirectory: "/repo",
      sessionId: "conv-123",
      conversationSummary: "Investigate mod context",
      agentId: "agent-123",
      agentName: "Test Agent",
      totalDurationMs: 10_000,
      totalApiDurationMs: 3_000,
      totalInputTokens: 1200,
      totalOutputTokens: 450,
      contextWindowSize: 200_000,
      usedContextTokens: 40_000,
      reflectionMode: "step-count",
      reflectionStepCount: 10,
      memfsEnabled: true,
      memfsDirectory: "/Users/test/.letta/agents/agent-123/memory",
      permissionMode: "standard",
      networkPhase: "download",
      terminalWidth: 120,
      backgroundAgents: [
        {
          type: "general-purpose",
          status: "running",
          durationMs: 1234,
          agentId: "agent-bg-1",
        },
      ],
    });

    expect(context.cwd).toBe("/repo");
    expect(context.workspace.currentDir).toBe("/repo");
    expect(context.workspace.projectDir).toBe("/repo");
    expect(context.sessionId).toBe("conv-123");
    expect(context.conversationSummary).toBe("Investigate mod context");
    expect(context.agent.id).toBe("agent-123");
    expect(context.agent.name).toBe("Test Agent");
    expect(context.model.id).toBe("anthropic/claude-sonnet-4");
    expect(context.model.displayName).toBe("Sonnet");
    expect(context.model.provider).toBe("anthropic");
    expect(context.contextWindow.usedPercentage).toBe(20);
    expect(context.contextWindow.remainingPercentage).toBe(80);
    expect(context.reflection.mode).toBe("step-count");
    expect(context.reflection.stepCount).toBe(10);
    expect(context.memfs.enabled).toBe(true);
    expect(context.memfs.memoryDir).toBe(
      "/Users/test/.letta/agents/agent-123/memory",
    );
    expect(context.permissionMode).toBe("standard");
    expect(context.networkPhase).toBe("download");
    expect(context.terminalWidth).toBe(120);
    expect(context.backgroundAgents).toEqual([
      {
        type: "general-purpose",
        status: "running",
        durationMs: 1234,
        agentId: "agent-bg-1",
      },
    ]);
  });

  test("marks unsupported fields as null", () => {
    const context = buildCliModContext({
      currentDirectory: "/repo",
      projectDirectory: "/repo",
    });

    expect(context.sessionId).toBeNull();
    expect(context.conversationSummary).toBeNull();
    expect(context.lastRunId).toBeNull();
    expect(context.agent.id).toBeNull();
    expect(context.agent.name).toBeNull();
    expect(context.model.id).toBeNull();
    expect(context.model.displayName).toBeNull();
    expect(context.model.provider).toBeNull();
    expect(context.model.reasoningEffort).toBeNull();
    expect(context.toolset).toBeNull();
    expect(context.systemPromptId).toBeNull();
    expect(context.permissionMode).toBeNull();
    expect(context.networkPhase).toBeNull();
    expect(context.terminalWidth).toBeNull();
    expect(context.contextWindow.currentUsage).toBeNull();
    expect(context.reflection.mode).toBeNull();
    expect(context.reflection.stepCount).toBe(0);
    expect(context.memfs.enabled).toBe(false);
    expect(context.memfs.memoryDir).toBeNull();
    expect(context.cost.totalCostUsd).toBeNull();
    expect(context.backgroundAgents).toEqual([]);
  });

  test("calculates context percentages safely", () => {
    expect(calculateContextPercentages(50, 200)).toEqual({
      used: 25,
      remaining: 75,
    });
    expect(calculateContextPercentages(500, 200)).toEqual({
      used: 100,
      remaining: 0,
    });
  });
});
