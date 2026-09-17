import { describe, expect, test } from "bun:test";
import stripAnsi from "strip-ansi";
import { renderModPanelLines } from "@/cli/components/ModPanelRow";
import type { ModContext } from "@/cli/mods/types";
import type { WorkflowExecutionSnapshot } from "@/tools/workflow/execution-registry";
import {
  createWorkflowStatusPanel,
  visibleWorkflowExecutions,
  WORKFLOW_ROW_LINGER_MS,
  WORKFLOW_STATUS_PANEL_ORDER,
  withWorkflowStatusPanel,
} from "./workflows";

function createContext(): ModContext {
  return {
    app: { version: "0.0.0-test" },
    workspace: {
      cwd: "/tmp/project",
      currentDir: "/tmp/project",
      projectDir: "/tmp/project",
    },
    cwd: "/tmp/project",
    sessionId: "conv-1",
    conversationSummary: null,
    lastRunId: null,
    agent: { id: "agent-1", name: "Amelia" },
    model: {
      id: "openai/gpt-5.5",
      displayName: "GPT-5.5",
      provider: "openai",
      reasoningEffort: null,
    },
    toolset: "auto",
    systemPromptId: null,
    permissionMode: "default",
    networkPhase: null,
    terminalWidth: 100,
    contextWindow: {
      size: 200000,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      usedPercentage: null,
      remainingPercentage: null,
      currentUsage: null,
    },
    cost: {
      totalDurationMs: 0,
      totalApiDurationMs: 0,
      totalCostUsd: null,
      totalLinesAdded: null,
      totalLinesRemoved: null,
    },
    reflection: { mode: null, stepCount: 0 },
    memfs: { enabled: false, memoryDir: null },
    backgroundAgents: [],
    subagents: { list: () => [] },
  };
}

function execution(
  overrides: Partial<WorkflowExecutionSnapshot> = {},
): WorkflowExecutionSnapshot {
  return {
    taskId: "workflow_1",
    executionId: "wf-abc",
    executionDir: "/tmp/wf-abc",
    scriptPath: "/tmp/wf-abc/script.js",
    outputFile: "/tmp/workflow_1.log",
    name: "simple-demo",
    description: "Quick demo workflow with parallel agents",
    status: "running",
    startedAt: 0,
    durationMs: 9_000,
    agentsTotal: 3,
    agentsDone: 0,
    agentsFailed: 0,
    agentsRunning: 3,
    cacheHits: 0,
    totalTokens: 133_600,
    totalCostUsd: 0,
    phases: [],
    logs: [],
    ...overrides,
  };
}

describe("workflow status panel", () => {
  test("renders one row per execution with progress on the right", () => {
    const lines = renderModPanelLines(
      createWorkflowStatusPanel([execution()]),
      100,
      createContext(),
    ).map(stripAnsi);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^○ simple-demo {2}Quick demo workflow with parallel agents\s+0\/3 agents done · 9s · ↓ 133\.6k tokens$/,
    );
  });

  test("collapses beyond four rows into a /workflows hint", () => {
    const executions = Array.from({ length: 6 }, (_, i) =>
      execution({ taskId: `workflow_${i}`, name: `flow-${i}` }),
    );
    const lines = renderModPanelLines(
      createWorkflowStatusPanel(executions),
      100,
      createContext(),
    ).map(stripAnsi);
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe("  +2 more · /workflows");
  });

  test("only running or recently finished executions are visible", () => {
    const now = 100_000;
    const visible = visibleWorkflowExecutions(
      [
        execution({ taskId: "running" }),
        execution({
          taskId: "fresh",
          status: "completed",
          finishedAt: now - WORKFLOW_ROW_LINGER_MS + 1,
        }),
        execution({
          taskId: "stale",
          status: "completed",
          finishedAt: now - WORKFLOW_ROW_LINGER_MS - 1,
        }),
      ],
      now,
    );
    expect(visible.map((e) => e.taskId)).toEqual(["running", "fresh"]);
  });

  test("withWorkflowStatusPanel adds a below-input panel only when needed", () => {
    expect(withWorkflowStatusPanel({}, [])).toEqual({});
    const panels = withWorkflowStatusPanel({}, [execution()]);
    expect(Object.values(panels)[0]?.order).toBe(WORKFLOW_STATUS_PANEL_ORDER);
    expect(WORKFLOW_STATUS_PANEL_ORDER).toBeLessThan(0);
  });
});
