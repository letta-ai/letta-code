import { afterEach, describe, expect, test } from "bun:test";
import type {
  EnqueueReceipt,
  ExactSuperRun,
} from "@/backend/api/conversation-enqueue";
import {
  type BackgroundTask,
  backgroundTasks,
  createBackgroundOutputFile,
} from "@/tools/impl/process_manager";
import { task_stop } from "@/tools/impl/task-stop";
import { stopRemoteRuns } from "./remote-run-stop";

const receipt: EnqueueReceipt = {
  status: "queued",
  agent_id: "agent-1",
  conversation_id: "conv-1",
  client_message_id: "cm-1",
  workflow_id: "wf-1",
  super_run_id: "sr-1",
};

function superRun(terminal: boolean): ExactSuperRun {
  return {
    id: "sr-1",
    status: terminal ? "CAN" : "RUN",
    completed_at: null,
    cancelled_at: terminal ? "2026-01-01T00:00:00Z" : null,
    errored_at: null,
    error: null,
    run_ids: ["run-1"],
  };
}

describe("stopRemoteRuns", () => {
  test("cancels the Cloud run once and reports stopped when terminal", async () => {
    const cancelled: string[] = [];
    let reads = 0;
    const result = await stopRemoteRuns(receipt, {
      exact: async () => superRun(++reads > 1),
      cancelRun: async (agentId, runId) => {
        cancelled.push(`${agentId}/${runId}`);
      },
      runStatus: async () => (cancelled.length ? "cancelled" : "running"),
      sleep: async () => {},
    });
    expect(result).toBe("stopped");
    expect(cancelled).toEqual(["agent-1/run-1"]);
  });

  test("reports unconfirmed when the run never becomes terminal", async () => {
    const result = await stopRemoteRuns(receipt, {
      exact: async () => superRun(true),
      cancelRun: async () => {},
      runStatus: async () => "running",
      sleep: async () => {},
      checks: 2,
    });
    expect(result).toBe("unconfirmed");
  });
});

describe("TaskStop for remote subagents", () => {
  afterEach(() => backgroundTasks.clear());

  function remoteTask(taskId: string, outcome: "stopped" | "unconfirmed") {
    const abortController = new AbortController();
    const task: BackgroundTask = {
      description: "remote",
      subagentType: "general-purpose",
      subagentId: `subagent_${taskId}`,
      status: "running",
      startTime: new Date(),
      outputFile: createBackgroundOutputFile(taskId),
      abortController,
      remoteStop: "unconfirmed",
    };
    task.completion = new Promise<void>((resolve) => {
      abortController.signal.addEventListener("abort", () => {
        task.remoteStop = outcome;
        resolve();
      });
    });
    backgroundTasks.set(taskId, task);
  }

  test("reports stopped only after the Cloud run is confirmed terminal", async () => {
    remoteTask("task_remote_stopped", "stopped");
    expect(await task_stop({ task_id: "task_remote_stopped" })).toEqual({
      killed: true,
      output: "Remote subagent stopped",
    });
  });

  test("reports an unconfirmed cancel instead of killed", async () => {
    remoteTask("task_remote_pending", "unconfirmed");
    const result = await task_stop({ task_id: "task_remote_pending" });
    expect(result.killed).toBe(false);
    expect(result.output).toContain("not yet confirmed");
  });
});
