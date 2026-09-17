import { describe, expect, test } from "bun:test";
import type { WorkflowExecutionSnapshot } from "@/tools/workflow/execution-registry";
import {
  describeWorkflowArgs,
  formatWaitingForWorkflows,
  formatWorkflowLaunchLine,
  formatWorkflowStatusRow,
  parseWorkflowTaskId,
  renderWorkflowTree,
} from "./workflow-display";

function snapshot(
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
    totalCostUsd: 0.1,
    phases: [
      {
        title: "Find",
        agents: [
          {
            callIndex: 0,
            label: "search:typescript",
            phase: "Find",
            status: "done",
            durationMs: 8_000,
            totalTokens: 40_100,
          },
          {
            callIndex: 1,
            label: "search:exports",
            phase: "Find",
            status: "running",
          },
          {
            callIndex: 2,
            label: "search:tests",
            phase: "Find",
            status: "queued",
          },
        ],
      },
      { title: "Summarize", agents: [] },
    ],
    logs: ["Starting parallel searches..."],
    ...overrides,
  };
}

const LAUNCH_TEXT = `Workflow launched in background. Task ID: workflow_7
Summary: Quick demo workflow with parallel agents
Execution ID: wf-abc`;

describe("workflow-display", () => {
  test("parses the task id from a launch message", () => {
    expect(parseWorkflowTaskId(LAUNCH_TEXT)).toBe("workflow_7");
    expect(parseWorkflowTaskId("meta.name is required")).toBeNull();
  });

  test("launch line is one short sentence", () => {
    expect(formatWorkflowLaunchLine(LAUNCH_TEXT)).toBe(
      "Launched in background · task workflow_7 · /workflows to watch",
    );
    expect(
      formatWorkflowLaunchLine("The meta block must be a literal"),
    ).toBeNull();
  });

  test("header shows the meta description, not the script", () => {
    const script = `export const meta = {
  name: 'simple-demo',
  description: "Quick demo workflow with parallel agents",
}
await agent("find 'stuff'")`;
    expect(describeWorkflowArgs({ script })).toBe(
      "Quick demo workflow with parallel agents",
    );
    expect(
      describeWorkflowArgs({
        script: "export const meta = { name: 'only-name', description: '' }",
      }),
    ).toBe("only-name");
    expect(
      describeWorkflowArgs({
        scriptPath: "/tmp/scripts/review-wf_1.js",
        resumeFromExecutionId: "wf-abc",
      }),
    ).toBe("review-wf_1.js, resume wf-abc");
    expect(describeWorkflowArgs({})).toBe("…");
  });

  test("status row mirrors the live registry snapshot", () => {
    expect(formatWorkflowStatusRow(snapshot())).toEqual({
      glyph: "○",
      name: "simple-demo",
      description: "Quick demo workflow with parallel agents",
      progress: "0/3 agents done · 9s · ↓ 133.6k tokens",
    });
    expect(
      formatWorkflowStatusRow(
        snapshot({ status: "failed", agentsDone: 1, durationMs: 12_000 }),
      ).progress,
    ).toBe("1/3 agents done · 12s · ↓ 133.6k tokens · failed");
    expect(
      formatWorkflowStatusRow(snapshot({ status: "completed" })).glyph,
    ).toBe("●");
  });

  test("waiting line pluralises", () => {
    expect(formatWaitingForWorkflows(1)).toBe(
      "Waiting for 1 workflow to finish",
    );
    expect(formatWaitingForWorkflows(2)).toBe(
      "Waiting for 2 workflows to finish",
    );
  });

  test("tree groups agents by phase with per-agent stats", () => {
    expect(renderWorkflowTree(snapshot({ error: "boom" }))).toEqual([
      "○ simple-demo — Quick demo workflow with parallel agents",
      "  0/3 agents done · 9s · ↓ 133.6k tokens",
      "  error: boom",
      "  Find (1/3)",
      "    ✓ search:typescript · 8s · 40.1k tokens",
      "    ▶ search:exports",
      "    · search:tests · queued",
      "  Summarize (0/0)",
      "  » Starting parallel searches...",
      "  task workflow_1 · execution wf-abc · log /tmp/workflow_1.log",
    ]);
  });
});
