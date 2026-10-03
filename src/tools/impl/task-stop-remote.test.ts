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
    const cancel = spyOn(getBackend(), "cancelConversation").mockResolvedValue(
      {} as never,
    );
    startRemoteTask("task_remote_ok", "conv-child");
    expect(await task_stop({ task_id: "task_remote_ok" })).toEqual({
      killed: true,
      output: "Cancelled the remote run",
    });
    expect(cancel).toHaveBeenCalledWith("conv-child");
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
    cancel.mockRestore();
  });
});
