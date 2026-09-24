import { describe, expect, test } from "bun:test";
import type { WorkflowExecutionSnapshot } from "@/tools/workflow/execution-registry";
import {
  formatWorkflowLaunchLine,
  formatWorkflowStatusRow,
  parseWorkflowTaskId,
  renderWorkflowTree,
} from "./workflow-display";

const SNAPSHOT: WorkflowExecutionSnapshot = {
  taskId: "workflow_1",
  executionDir: "/runs/wf-1",
  outputFile: "/runs/wf-1/out.log",
  name: "review",
  description: "Review changed files",
  status: "running",
  durationMs: 9_000,
  agentsTotal: 3,
  agentsDone: 1,
  agentsFailed: 1,
  agentsRunning: 1,
  totalTokens: 133_600,
  phases: [
    {
      title: "Review",
      agents: [
        {
          callIndex: 0,
          label: "review:a.ts",
          phase: "Review",
          status: "done",
          durationMs: 4_000,
          totalTokens: 120_000,
        },
        {
          callIndex: 1,
          label: "review:b.ts",
          phase: "Review",
          status: "running",
        },
      ],
    },
    {
      title: "Verify",
      agents: [
        {
          callIndex: 2,
          label: "verify:a.ts",
          phase: "Verify",
          status: "error",
          detail: "timed out",
          totalTokens: 13_600,
        },
      ],
    },
  ],
  logs: ["starting", "2 findings"],
};

describe("renderWorkflowTree", () => {
  test("renders phases, agents, tokens, logs, and the task pointer", () => {
    expect(renderWorkflowTree(SNAPSHOT)).toEqual([
      "○ review — Review changed files",
      "  1/3 agents done · 9s · 133.6k tokens",
      "  Review (1/2)",
      "    ✓ review:a.ts · 4s · 120k tokens",
      "    ▶ review:b.ts",
      "  Verify (0/1)",
      "    ✗ verify:a.ts · 13.6k tokens · timed out",
      "  » starting",
      "  » 2 findings",
      "  task workflow_1 · log /runs/wf-1/out.log",
    ]);
  });

  test("marks failed runs and shows their error", () => {
    const lines = renderWorkflowTree({
      ...SNAPSHOT,
      status: "failed",
      error: "Workflow stopped",
      phases: [],
      logs: [],
    });
    expect(lines[0]).toStartWith("✗ review");
    expect(lines[1]).toBe("  1/3 agents done · 9s · 133.6k tokens · failed");
    expect(lines[2]).toBe("  error: Workflow stopped");
  });
});

describe("launch line and status row", () => {
  test("parses the task id from a launch result and summarizes it", () => {
    const result =
      "Workflow launched in background. Task ID: workflow_7\nSummary: x";
    expect(parseWorkflowTaskId(result)).toBe("workflow_7");
    expect(formatWorkflowLaunchLine(result)).toBe(
      "Launched in background · task workflow_7 · /workflows to watch",
    );
    expect(parseWorkflowTaskId("Provide `script`")).toBeNull();
    expect(formatWorkflowLaunchLine("Provide `script`")).toBeNull();
  });

  test("status row carries glyph, name, description and progress", () => {
    expect(formatWorkflowStatusRow(SNAPSHOT)).toEqual({
      glyph: "○",
      name: "review",
      description: "Review changed files",
      progress: "1/3 agents done · 9s · 133.6k tokens",
    });
    expect(
      formatWorkflowStatusRow({ ...SNAPSHOT, status: "failed" }).progress,
    ).toBe("1/3 agents done · 9s · 133.6k tokens · failed");
  });
});
