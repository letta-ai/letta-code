import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetWorkflowExecutionsForTests,
  countRunningWorkflowExecutions,
  finishWorkflowExecution,
  getWorkflowExecution,
  listWorkflowExecutions,
  recordWorkflowProgress,
  registerWorkflowExecution,
  subscribeToWorkflowExecutions,
} from "./execution-registry.ts";

function register(taskId = "workflow_1") {
  return registerWorkflowExecution({
    taskId,
    executionId: "wf-abc",
    executionDir: "/tmp/wf-abc",
    scriptPath: "/tmp/wf-abc/script.js",
    outputFile: "/tmp/workflow_1.log",
    meta: {
      name: "simple-demo",
      description: "Quick demo workflow with parallel agents",
      phases: [{ title: "Find" }, { title: "Summarize" }],
    },
    startedAt: 1_000,
  });
}

afterEach(() => {
  __resetWorkflowExecutionsForTests();
});

describe("workflow execution registry", () => {
  test("registers a running execution with the declared phases", () => {
    register();
    const snapshot = getWorkflowExecution("workflow_1");
    expect(snapshot?.status).toBe("running");
    expect(snapshot?.name).toBe("simple-demo");
    expect(snapshot?.phases.map((p) => p.title)).toEqual(["Find", "Summarize"]);
    expect(countRunningWorkflowExecutions()).toBe(1);
  });

  test("tracks agent progress, tokens, and phase grouping", () => {
    register();
    recordWorkflowProgress("workflow_1", { kind: "phase", title: "Find" });
    for (const callIndex of [0, 1, 2]) {
      recordWorkflowProgress("workflow_1", {
        kind: "agent",
        callIndex,
        label: `search:${callIndex}`,
        phase: "Find",
        status: "running",
      });
    }
    recordWorkflowProgress("workflow_1", {
      kind: "agent",
      callIndex: 0,
      label: "search:0",
      phase: "Find",
      status: "done",
      durationMs: 8_000,
      totalTokens: 40_000,
      costUsd: 0.02,
    });
    recordWorkflowProgress("workflow_1", {
      kind: "agent",
      callIndex: 3,
      label: "synthesize",
      phase: "Summarize",
      status: "cached",
    });
    recordWorkflowProgress("workflow_1", { kind: "log", message: "hello" });

    const snapshot = getWorkflowExecution("workflow_1");
    expect(snapshot?.agentsTotal).toBe(4);
    expect(snapshot?.agentsDone).toBe(2);
    expect(snapshot?.agentsRunning).toBe(2);
    expect(snapshot?.cacheHits).toBe(1);
    expect(snapshot?.totalTokens).toBe(40_000);
    expect(snapshot?.totalCostUsd).toBeCloseTo(0.02);
    expect(snapshot?.phases[0]?.agents.map((a) => a.label)).toEqual([
      "search:0",
      "search:1",
      "search:2",
    ]);
    expect(snapshot?.phases[1]?.agents.map((a) => a.status)).toEqual([
      "cached",
    ]);
    expect(snapshot?.logs).toEqual(["hello"]);
  });

  test("finishing marks stragglers as interrupted and notifies subscribers", () => {
    register();
    let notified = 0;
    const unsubscribe = subscribeToWorkflowExecutions(() => {
      notified += 1;
    });
    recordWorkflowProgress("workflow_1", {
      kind: "agent",
      callIndex: 0,
      label: "a",
      phase: null,
      status: "running",
    });
    finishWorkflowExecution("workflow_1", {
      status: "failed",
      error: "Workflow stopped",
    });
    unsubscribe();

    const snapshot = getWorkflowExecution("workflow_1");
    expect(notified).toBe(2);
    expect(snapshot?.status).toBe("failed");
    expect(snapshot?.error).toBe("Workflow stopped");
    expect(snapshot?.agentsFailed).toBe(1);
    // Declared phases come first; a phase-less agent lands in "(no phase)".
    const unphased = snapshot?.phases.find((p) => p.title === "(no phase)");
    expect(unphased?.agents[0]?.status).toBe("error");
    expect(unphased?.agents[0]?.detail).toBe("interrupted");
    expect(countRunningWorkflowExecutions()).toBe(0);
  });

  test("lists executions oldest first", () => {
    register("workflow_2");
    registerWorkflowExecution({
      taskId: "workflow_1",
      executionId: "wf-old",
      executionDir: "/tmp/wf-old",
      scriptPath: "/tmp/wf-old/script.js",
      outputFile: "/tmp/workflow_1.log",
      meta: { name: "older", description: "older run" },
      startedAt: 10,
    });
    expect(listWorkflowExecutions().map((s) => s.taskId)).toEqual([
      "workflow_1",
      "workflow_2",
    ]);
  });
});
