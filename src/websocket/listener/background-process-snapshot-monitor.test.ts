import { afterEach, describe, expect, test } from "bun:test";
import {
  type BackgroundProcess,
  backgroundProcesses,
} from "@/tools/impl/process_manager";
import {
  __resetWorkflowExecutionsForTests,
  recordWorkflowProgress,
  registerWorkflowExecution,
} from "@/tools/workflow/execution-registry";
import { buildBackgroundProcessSnapshot } from "./background-process-snapshot";

afterEach(() => {
  backgroundProcesses.clear();
  __resetWorkflowExecutionsForTests();
});

describe("background process snapshots", () => {
  test("reports only running monitors in their owning runtime", () => {
    backgroundProcesses.set("monitor_1", {
      process: { kill: () => {} },
      command: "tail -f app.log",
      stdout: [],
      stderr: [],
      status: "running",
      exitCode: null,
      startTime: new Date(1234),
      runtimeScope: { agentId: "agent-a", conversationId: "conv-a" },
      kind: "monitor",
      description: "application errors",
      monitorSource: "command",
      persistent: true,
    });
    backgroundProcesses.set("monitor_2", {
      process: { kill: () => {} },
      command: "wss://events.example.com",
      stdout: [],
      stderr: [],
      status: "completed",
      exitCode: 1000,
      startTime: new Date(5678),
      runtimeScope: { agentId: "agent-a", conversationId: "conv-a" },
      kind: "monitor",
      description: "deploy events",
      monitorSource: "websocket",
      persistent: false,
    });

    expect(buildBackgroundProcessSnapshot("agent-a", "conv-a")).toEqual([
      {
        process_id: "monitor_1",
        kind: "monitor",
        description: "application errors",
        source: "command",
        started_at_ms: 1234,
        status: "running",
        persistent: true,
      },
    ]);
    expect(buildBackgroundProcessSnapshot("agent-b", "conv-a")).toEqual([]);
  });

  test("reports GitHub PR watchers as persistent monitors", () => {
    backgroundProcesses.set("monitor-pr", {
      process: { kill() {} },
      command: "https://github.com/letta-ai/letta-code/pull/42",
      status: "running",
      exitCode: null,
      startTime: new Date(1000),
      runtimeScope: { agentId: "agent-a", conversationId: "conv-a" },
      kind: "monitor",
      description: "PR letta-ai/letta-code#42",
      monitorSource: "github_pull_request",
      persistent: true,
    });

    expect(buildBackgroundProcessSnapshot("agent-a", "conv-a")).toContainEqual({
      process_id: "monitor-pr",
      kind: "monitor",
      description: "PR letta-ai/letta-code#42",
      source: "github_pull_request",
      started_at_ms: 1000,
      status: "running",
      persistent: true,
    });
  });

  test("reports running workflows separately from Bash processes", () => {
    backgroundProcesses.set("workflow_1", {
      process: { kill: () => {} },
      command: "workflow review-changes",
      stdout: [],
      stderr: [],
      status: "running",
      exitCode: null,
      lastReadIndex: { stdout: 0, stderr: 0 },
      startTime: new Date(5678),
      runtimeScope: { agentId: "agent-a", conversationId: "conv-a" },
      kind: "workflow",
      description: "Review changed files across dimensions",
    } as BackgroundProcess);

    expect(buildBackgroundProcessSnapshot("agent-a", "conv-a")).toEqual([
      {
        process_id: "workflow_1",
        kind: "workflow",
        description: "Review changed files across dimensions",
        started_at_ms: 5678,
        status: "running",
      },
    ]);
  });

  test("projects overlapping phases, cumulative usage, and completion only to the owner", () => {
    backgroundProcesses.set("workflow_1", {
      process: { kill() {} },
      command: "workflow review",
      kind: "workflow",
      description: "Review files",
      status: "running",
      exitCode: null,
      startTime: new Date(1000),
      runtimeScope: { agentId: "agent-a", conversationId: "conv-a" },
    });
    registerWorkflowExecution({
      taskId: "workflow_1",
      executionDir: "/private/run",
      outputFile: "/private/run/out.log",
      meta: {
        name: "review",
        description: "Review files",
        phases: [{ title: "Review" }, { title: "Verify" }],
      },
    });
    for (const [callIndex, phase, status, totalTokens] of [
      [0, "Review", "done", 100],
      [1, "Review", "running", 200],
      [2, "Verify", "error", 50],
      [3, "Verify", "running", 300],
    ] as const) {
      recordWorkflowProgress("workflow_1", {
        kind: "agent",
        callIndex,
        label: `worker-${callIndex}`,
        phase,
        status,
        totalTokens,
      });
    }
    recordWorkflowProgress("workflow_1", {
      kind: "decision_usage",
      totalTokens: 10,
    });
    const snapshot = buildBackgroundProcessSnapshot("agent-a", "conv-a");
    expect(snapshot[0]).toMatchObject({
      progress: {
        agents_total: 4,
        agents_done: 1,
        agents_failed: 1,
        agents_running: 2,
        total_tokens: 660,
        phases: [
          {
            title: "Review",
            agents_total: 2,
            agents_done: 1,
            agents_failed: 0,
            agents_running: 1,
            total_tokens: 300,
          },
          {
            title: "Verify",
            agents_total: 2,
            agents_done: 0,
            agents_failed: 1,
            agents_running: 1,
            total_tokens: 350,
          },
        ],
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("/private/run");
    expect(buildBackgroundProcessSnapshot("agent-a", "conv-b")).toEqual([]);
    recordWorkflowProgress("workflow_1", {
      kind: "agent",
      callIndex: 1,
      label: "worker-1",
      phase: "Review",
      status: "done",
      totalTokens: 400,
    });
    expect(
      buildBackgroundProcessSnapshot("agent-a", "conv-a")[0],
    ).toMatchObject({ progress: { agents_done: 2, total_tokens: 860 } });
    const process = backgroundProcesses.get("workflow_1");
    if (process) process.status = "completed";
    expect(buildBackgroundProcessSnapshot("agent-a", "conv-a")).toEqual([]);
  });
});
