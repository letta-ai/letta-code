import { describe, expect, test } from "bun:test";
import stripAnsi from "strip-ansi";
import { renderModPanelLines } from "@/cli/components/ModPanelRow";
import type { ModContext, ModPanel } from "@/cli/mods/types";
import type { WorkflowExecutionSnapshot } from "@/tools/workflow/execution-registry";
import {
  createWorkflowStatusPanel,
  visibleWorkflowExecutions,
  WORKFLOW_ROW_LINGER_MS,
  WORKFLOW_STATUS_PANEL_ID,
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

function snapshot(
  overrides: Partial<WorkflowExecutionSnapshot> = {},
): WorkflowExecutionSnapshot {
  return {
    taskId: "workflow_1",
    executionDir: "/runs/wf-1",
    outputFile: "/runs/wf-1/out.log",
    name: "simple-demo",
    description: "Quick demo workflow",
    status: "running",
    durationMs: 9_000,
    agentsTotal: 3,
    agentsDone: 1,
    agentsFailed: 0,
    agentsRunning: 2,
    totalTokens: 133_600,
    phases: [],
    logs: [],
    ...overrides,
  };
}

describe("visibleWorkflowExecutions", () => {
  test("keeps running runs and recently finished ones", () => {
    const now = 1_000_000;
    const running = snapshot({ taskId: "a" });
    const justFinished = snapshot({
      taskId: "b",
      status: "completed",
      finishedAt: now - WORKFLOW_ROW_LINGER_MS + 1,
    });
    const old = snapshot({
      taskId: "c",
      status: "failed",
      finishedAt: now - WORKFLOW_ROW_LINGER_MS - 1,
    });
    expect(
      visibleWorkflowExecutions([running, justFinished, old], now).map(
        (r) => r.taskId,
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("workflow status panel", () => {
  test("renders one row per run with the progress fragment on the right", () => {
    const lines = renderModPanelLines(
      createWorkflowStatusPanel([
        snapshot(),
        snapshot({
          taskId: "workflow_2",
          name: "audit",
          description: "Audit the listener",
          status: "failed",
          agentsDone: 3,
          agentsRunning: 0,
          totalTokens: 0,
        }),
      ]),
      100,
      createContext(),
    ).map(stripAnsi);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("○ simple-demo  Quick demo workflow");
    expect(lines[0]).toEndWith("1/3 agents done · 9s · 133.6k tokens");
    expect(lines[1]).toStartWith("✗ audit  Audit the listener");
    expect(lines[1]).toEndWith("3/3 agents done · 9s · failed");
  });

  test("caps rows and points to /workflows for the rest", () => {
    const runs = Array.from({ length: 6 }, (_, i) =>
      snapshot({ taskId: `workflow_${i}`, name: `run-${i}` }),
    );
    const lines = renderModPanelLines(
      createWorkflowStatusPanel(runs),
      100,
      createContext(),
    ).map(stripAnsi);
    expect(lines).toHaveLength(5);
    expect(lines[4]?.trim()).toBe("+2 more · /workflows");
  });

  test("withWorkflowStatusPanel adds a below-input panel only when there are runs", () => {
    const existing: Record<string, ModPanel> = {
      "mod:x": {
        id: "mod:x",
        order: 2,
        path: "mod:x",
        updatedAt: 0,
        render: () => "x",
      },
    };
    expect(withWorkflowStatusPanel(existing, [])).toBe(existing);
    const withRows = withWorkflowStatusPanel(existing, [snapshot()]);
    expect(Object.keys(withRows).sort()).toEqual([
      WORKFLOW_STATUS_PANEL_ID,
      "mod:x",
    ]);
    expect(withRows[WORKFLOW_STATUS_PANEL_ID]?.order).toBe(
      WORKFLOW_STATUS_PANEL_ORDER,
    );
    expect(WORKFLOW_STATUS_PANEL_ORDER).toBeLessThan(0);
  });
});
