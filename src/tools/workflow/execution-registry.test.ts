import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetWorkflowExecutionsForTests,
  finishWorkflowExecution,
  getWorkflowExecution,
  getWorkflowExecutionsVersion,
  listWorkflowExecutions,
  recordWorkflowProgress,
  registerWorkflowExecution,
  subscribeToWorkflowExecutions,
} from "./execution-registry.ts";

const META = {
  name: "demo",
  description: "demo run",
  phases: [{ title: "Find" }],
};

function register(taskId = "workflow_1", startedAt = 1_000) {
  registerWorkflowExecution({
    taskId,
    executionDir: "/runs/wf-1",
    outputFile: "/runs/wf-1/out.log",
    meta: META,
    startedAt,
  });
}

describe("workflow execution registry", () => {
  afterEach(() => __resetWorkflowExecutionsForTests());

  test("tracks agents by phase, token totals, and logs", () => {
    register();
    recordWorkflowProgress("workflow_1", { kind: "phase", title: "Find" });
    recordWorkflowProgress("workflow_1", { kind: "log", message: "starting" });
    for (const [callIndex, label] of [
      [0, "a"],
      [1, "b"],
    ] as const) {
      recordWorkflowProgress("workflow_1", {
        kind: "agent",
        callIndex,
        label,
        phase: "Find",
        status: "queued",
      });
      recordWorkflowProgress("workflow_1", {
        kind: "agent",
        callIndex,
        label,
        phase: "Find",
        status: "running",
      });
    }
    recordWorkflowProgress("workflow_1", {
      kind: "agent",
      callIndex: 0,
      label: "a",
      phase: "Find",
      status: "done",
      durationMs: 1500,
      totalTokens: 12_000,
    });
    // An agent outside any phase() gets its own group.
    recordWorkflowProgress("workflow_1", {
      kind: "agent",
      callIndex: 2,
      label: "c",
      phase: null,
      status: "error",
      detail: "timed out",
      totalTokens: 500,
    });

    const live = getWorkflowExecution("workflow_1");
    expect(live).toMatchObject({
      status: "running",
      agentsTotal: 3,
      agentsDone: 1,
      agentsRunning: 1,
      agentsFailed: 1,
      totalTokens: 12_500,
      logs: ["starting"],
    });
    expect(live?.phases.map((p) => p.title)).toEqual(["Find", "(no phase)"]);
    expect(live?.phases[0]?.agents.map((a) => [a.label, a.status])).toEqual([
      ["a", "done"],
      ["b", "running"],
    ]);
    expect(live?.phases[0]?.agents[0]).toMatchObject({
      durationMs: 1500,
      totalTokens: 12_000,
    });
  });

  test("sums the latest per-agent usage so running agents count live", () => {
    register();
    const running = (callIndex: number, totalTokens?: number) =>
      recordWorkflowProgress("workflow_1", {
        kind: "agent",
        callIndex,
        label: `a${callIndex}`,
        phase: null,
        status: "running",
        ...(totalTokens === undefined ? {} : { totalTokens }),
      });
    running(0);
    running(1);
    expect(getWorkflowExecution("workflow_1")?.totalTokens).toBe(0);
    running(0, 1_000);
    running(1, 400);
    expect(getWorkflowExecution("workflow_1")?.totalTokens).toBe(1_400);
    // Cumulative per agent: the newer figure replaces, never adds to, the old.
    running(0, 2_500);
    expect(getWorkflowExecution("workflow_1")?.totalTokens).toBe(2_900);
    recordWorkflowProgress("workflow_1", {
      kind: "agent",
      callIndex: 0,
      label: "a0",
      phase: null,
      status: "done",
      totalTokens: 3_000,
    });
    // A terminal event without a figure keeps the last one seen.
    recordWorkflowProgress("workflow_1", {
      kind: "agent",
      callIndex: 1,
      label: "a1",
      phase: null,
      status: "error",
      detail: "timed out",
    });
    expect(getWorkflowExecution("workflow_1")).toMatchObject({
      totalTokens: 3_400,
      agentsDone: 1,
      agentsFailed: 1,
    });
  });

  test("includes decision usage without adding a synthetic agent", () => {
    register();
    recordWorkflowProgress("workflow_1", {
      kind: "agent",
      callIndex: 0,
      label: "worker",
      phase: null,
      status: "done",
      totalTokens: 50,
    });
    recordWorkflowProgress("workflow_1", {
      kind: "decision_usage",
      totalTokens: 37,
    });
    expect(getWorkflowExecution("workflow_1")).toMatchObject({
      agentsTotal: 1,
      totalTokens: 87,
    });
  });

  test("finishing marks unreported agents as interrupted and freezes duration", () => {
    register("workflow_1", Date.now() - 5_000);
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
    const finished = getWorkflowExecution("workflow_1");
    expect(finished).toMatchObject({
      status: "failed",
      error: "Workflow stopped",
      agentsFailed: 1,
      agentsRunning: 0,
    });
    const agent = finished?.phases.flatMap((p) => p.agents)[0];
    expect(agent).toMatchObject({ status: "error", detail: "interrupted" });
    expect(finished?.durationMs).toBeGreaterThanOrEqual(5_000);
    expect(finished?.durationMs).toBeLessThan(6_000);
  });

  test("lists runs oldest first and ignores events for unknown tasks", () => {
    register("workflow_2", 2_000);
    register("workflow_1", 1_000);
    recordWorkflowProgress("workflow_9", { kind: "log", message: "lost" });
    expect(listWorkflowExecutions().map((r) => r.taskId)).toEqual([
      "workflow_1",
      "workflow_2",
    ]);
    expect(getWorkflowExecution("workflow_9")).toBeNull();
  });

  test("coalesces a burst of changes into one notification per tick", async () => {
    let calls = 0;
    const unsubscribe = subscribeToWorkflowExecutions(() => {
      calls += 1;
    });
    const before = getWorkflowExecutionsVersion();
    register();
    for (let i = 0; i < 40; i++) {
      recordWorkflowProgress("workflow_1", {
        kind: "agent",
        callIndex: i,
        label: `a${i}`,
        phase: null,
        status: "queued",
      });
    }
    finishWorkflowExecution("workflow_1", { status: "completed" });
    // Synchronous burst: nothing has been published yet, but reads are live.
    expect(calls).toBe(0);
    expect(getWorkflowExecution("workflow_1")?.agentsTotal).toBe(40);
    await Bun.sleep(5);
    expect(calls).toBe(1);
    expect(getWorkflowExecutionsVersion()).toBe(before + 1);
    expect(getWorkflowExecution("workflow_1")?.finishedAt).toBeGreaterThan(0);
    unsubscribe();
    recordWorkflowProgress("workflow_1", { kind: "log", message: "later" });
    await Bun.sleep(5);
    expect(calls).toBe(1);
  });
});
