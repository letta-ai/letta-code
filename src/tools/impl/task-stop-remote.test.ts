import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  clearAllSubagents,
  registerSubagent,
  updateSubagent,
} from "@/agent/subagent-state.js";
import { getBackend } from "@/backend";
import {
  backgroundTasks,
  createBackgroundOutputFile,
} from "@/tools/impl/process_manager";
import { task_stop } from "@/tools/impl/task-stop";

function startRemoteTask(taskId: string, conversationId: string) {
  registerSubagent(
    `sub_${taskId}`,
    "general-purpose",
    "remote",
    undefined,
    true,
  );
  updateSubagent(`sub_${taskId}`, { conversationId });
  backgroundTasks.set(taskId, {
    description: "remote",
    subagentType: "general-purpose",
    subagentId: `sub_${taskId}`,
    status: "running",
    startTime: new Date(),
    outputFile: createBackgroundOutputFile(taskId),
    abortController: new AbortController(),
    completion: Promise.resolve(),
    remote: true,
  });
}

describe("TaskStop for remote subagents", () => {
  afterEach(() => {
    backgroundTasks.clear();
    clearAllSubagents();
  });

  test("cancels the child conversation in Cloud", async () => {
    const cancel = spyOn(getBackend(), "cancelConversation").mockResolvedValue({
      "run-child": "cancelled",
    });
    startRemoteTask("task_remote_ok", "conv-child");
    expect(await task_stop({ task_id: "task_remote_ok" })).toEqual({
      killed: true,
      output: "Cancelled the remote run",
    });
    expect(cancel).toHaveBeenCalledWith("conv-child");
    cancel.mockRestore();
  });

  test("does not claim success or lose the handle when Cloud returns a failed run", async () => {
    const cancel = spyOn(getBackend(), "cancelConversation").mockResolvedValue({
      "run-child": "cancelled",
      "run-still-active": "failed",
    });
    startRemoteTask("task_remote_partial", "conv-child");
    const task = backgroundTasks.get("task_remote_partial");

    expect(await task_stop({ task_id: "task_remote_partial" })).toEqual({
      killed: false,
      output: "Couldn't cancel the remote run: Cloud did not cancel every run",
    });
    expect(task?.abortController?.signal.aborted).toBe(false);
    expect(task?.status).toBe("running");
    cancel.mockRestore();
  });

  test("does not claim success when Cloud returns no cancelled runs", async () => {
    const cancel = spyOn(getBackend(), "cancelConversation").mockResolvedValue(
      {},
    );
    startRemoteTask("task_remote_empty", "conv-child");

    expect(await task_stop({ task_id: "task_remote_empty" })).toEqual({
      killed: false,
      output: "Couldn't cancel the remote run: Cloud did not cancel every run",
    });
    cancel.mockRestore();
  });

  test("reports a failed Cloud cancel instead of killed", async () => {
    const cancel = spyOn(getBackend(), "cancelConversation").mockRejectedValue(
      new Error("boom"),
    );
    startRemoteTask("task_remote_err", "conv-child");
    expect(await task_stop({ task_id: "task_remote_err" })).toEqual({
      killed: false,
      output: "Couldn't cancel the remote run: boom",
    });
    expect(backgroundTasks.get("task_remote_err")?.status).toBe("running");
    cancel.mockRestore();
  });
});
