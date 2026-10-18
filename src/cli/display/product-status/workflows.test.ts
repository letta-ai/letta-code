import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
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
    expect(lines).toHaveLength(4);
    expect(lines[0]).toStartWith("○ simple-demo");
    expect(lines[0]).toEndWith("1/3 agents done · 9s · 133.6k tokens");
    expect(lines[1]).toBe("  Quick demo workflow");
    expect(lines[2]).toStartWith("✗ audit");
    expect(lines[2]).toEndWith("3/3 agents done · 9s · failed");
    expect(lines[3]).toBe("  Audit the listener");
  });

  test("keeps the name and progress legible beside a long description", () => {
    const run = snapshot({
      name: "init-history-final",
      description:
        "Final history-cohort analysis: compare all twelve agent reports and synthesize findings",
      agentsTotal: 12,
      agentsDone: 0,
      totalTokens: 8_800,
    });
    for (const width of [48, 60, 100]) {
      const lines = renderModPanelLines(
        createWorkflowStatusPanel([run]),
        width,
        createContext(),
      ).map(stripAnsi);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toStartWith("○ init-history-final");
      expect(lines[0]).toContain("0/12 agents done");
      expect(lines[1]).toStartWith("  Final history-cohort analysis:");
      expect(lines.every((line) => stringWidth(line) <= width)).toBe(true);
    }
  });

  test("keeps failed status visible when optional metrics do not fit", () => {
    const lines = renderModPanelLines(
      createWorkflowStatusPanel([
        snapshot({
          name: "init-history-final",
          status: "failed",
          agentsTotal: 12,
          agentsDone: 2,
          totalTokens: 8_800,
        }),
      ]),
      48,
      createContext(),
    ).map(stripAnsi);
    expect(lines[0]).toStartWith("✗ init-history-final");
    expect(lines[0]).toContain("2/12 agents done");
    expect(lines[0]).toContain("failed");
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
    expect(lines).toHaveLength(7);
    expect(lines[6]?.trim()).toBe("+3 more · /workflows");
  });

  test("shows active runs before newer completed runs under the panel cap", () => {
    const now = 100_000;
    const runs = [
      ...Array.from({ length: 4 }, (_, index) =>
        snapshot({
          taskId: `finished-${index}`,
          name: `finished-${index}`,
          status: "completed",
          finishedAt: now - (4 - index) * 1_000,
        }),
      ),
      snapshot({ taskId: "active", name: "active" }),
    ];
    const lines = renderModPanelLines(
      createWorkflowStatusPanel(visibleWorkflowExecutions(runs, now)),
      100,
      createContext(),
    ).map(stripAnsi);
    expect(lines[0]).toStartWith("○ active");
    expect(lines[2]).toStartWith("● finished-3");
    expect(lines[4]).toStartWith("● finished-2");
    expect(lines[6]?.trim()).toBe("+2 more · /workflows");
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
