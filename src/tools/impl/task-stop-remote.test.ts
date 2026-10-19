import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  clearAllSubagents,
  clearCompletedSubagents,
  getSubagents,
  interruptActiveSubagents,
  registerSubagent,
  registerSubagentAbortHook,
  updateSubagent,
} from "@/agent/subagent-state.js";
import { getBackend } from "@/backend";
import {
  backgroundTasks,
  createBackgroundOutputFile,
} from "@/tools/impl/process_manager";
import { buildBackgroundTaskAbortHook } from "@/tools/impl/task-abort-hook";
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

  test("sends subagent_stop for a remote external task", async () => {
    const agentId = "claude_11111111-1111-4111-8111-111111111111@device-1";
    registerSubagent(
      "sub_external",
      "claude-code",
      "remote external",
      undefined,
      true,
      false,
      { agentId: "agent-parent", conversationId: "conv-parent" },
    );
    updateSubagent("sub_external", { agentId, status: "running" });
    const abortController = new AbortController();
    backgroundTasks.set("task_external", {
      description: "remote external",
      subagentType: "claude-code",
      subagentId: "sub_external",
      status: "running",
      startTime: new Date(),
      outputFile: createBackgroundOutputFile("task_external"),
      abortController,
      completion: Promise.resolve(),
      runtimeScope: {
        agentId: "agent-parent",
        conversationId: "conv-parent",
      },
    });
    let received: unknown;
    expect(
      await task_stop(
        { task_id: "task_external" },
        {
          stopRemoteExternal: async (input) => {
            received = input;
            return { stopped: true };
          },
        },
      ),
    ).toMatchObject({ killed: true });
    expect(received).toMatchObject({ agentId });
    expect(abortController.signal.aborted).toBe(true);
  });
});

describe("Background task interrupt hook", () => {
  afterEach(() => {
    backgroundTasks.clear();
    clearAllSubagents();
  });

  test("routes a user interrupt through TaskStop and cancels the remote run", async () => {
    const cancel = spyOn(getBackend(), "cancelConversation").mockResolvedValue({
      "run-child": "cancelled",
    });
    startRemoteTask("task_hook_remote", "conv-child");
    const controller = backgroundTasks.get("task_hook_remote")
      ?.abortController as AbortController;

    buildBackgroundTaskAbortHook("task_hook_remote", controller)();
    await Bun.sleep(20);

    expect(cancel).toHaveBeenCalledWith("conv-child");
    expect(controller.signal.aborted).toBe(true);
    cancel.mockRestore();
  });

  test("preserves the remote task handle when TaskStop cannot claim the kill", async () => {
    const cancel = spyOn(getBackend(), "cancelConversation").mockResolvedValue({
      "run-child": "failed",
    });
    startRemoteTask("task_hook_preserve", "conv-child");
    const controller = backgroundTasks.get("task_hook_preserve")
      ?.abortController as AbortController;

    buildBackgroundTaskAbortHook("task_hook_preserve", controller)();
    await Bun.sleep(20);

    expect(cancel).toHaveBeenCalledWith("conv-child");
    // task_stop deliberately returned killed:false without aborting so the
    // handle survives for a retry; the hook must not destroy that handle.
    expect(controller.signal.aborted).toBe(false);
    expect(backgroundTasks.get("task_hook_preserve")?.status).toBe("running");
    cancel.mockRestore();
  });

  test("aborts a local task locally when TaskStop cannot claim the kill", async () => {
    registerSubagent("sub_task_hook_local", "general-purpose", "local");
    updateSubagent("sub_task_hook_local", { conversationId: "conv-local" });
    const controller = new AbortController();
    backgroundTasks.set("task_hook_local", {
      description: "local",
      subagentType: "general-purpose",
      subagentId: "sub_task_hook_local",
      // Not running: task_stop returns killed:false without aborting, so
      // the hook's fail-safe local abort is the only thing that fires.
      status: "failed",
      startTime: new Date(),
      outputFile: createBackgroundOutputFile("task_hook_local"),
      abortController: controller,
      completion: Promise.resolve(),
      remote: false,
    });

    buildBackgroundTaskAbortHook("task_hook_local", controller)();
    await Bun.sleep(20);

    // Local tasks have no remote handle to preserve: fail-safe local abort.
    expect(controller.signal.aborted).toBe(true);
  });

  test("restores the subagent row so a failed remote cancel stays retryable", async () => {
    const cancel = spyOn(getBackend(), "cancelConversation").mockResolvedValue({
      "run-child": "failed",
    });
    startRemoteTask("task_hook_retry", "conv-child");
    const controller = backgroundTasks.get("task_hook_retry")
      ?.abortController as AbortController;
    registerSubagentAbortHook(
      "sub_task_hook_retry",
      buildBackgroundTaskAbortHook("task_hook_retry", controller),
    );

    // First interrupt: fires the hook, errored the row, removed the hook.
    interruptActiveSubagents("Interrupted by user");
    await Bun.sleep(20);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(false);

    // The failed remote cancel restored the row: it survives completed-row
    // cleanup and keeps the conversationId a TaskStop retry needs.
    expect(
      getSubagents().find((a) => a.id === "sub_task_hook_retry")?.status,
    ).toBe("running");
    clearCompletedSubagents();
    expect(getSubagents().some((a) => a.id === "sub_task_hook_retry")).toBe(
      true,
    );

    // A later interrupt reaches the re-armed hook and retries the cancel.
    interruptActiveSubagents("Interrupted by user");
    await Bun.sleep(20);
    expect(cancel).toHaveBeenCalledTimes(2);
    cancel.mockRestore();
  });

  test("leaves a completed subagent row settled when the cancel reports killed:false", async () => {
    const cancel = spyOn(getBackend(), "cancelConversation").mockResolvedValue({
      "run-child": "failed",
    });
    startRemoteTask("task_hook_completed", "conv-child");
    updateSubagent("sub_task_hook_completed", { status: "completed" });
    const controller = backgroundTasks.get("task_hook_completed")
      ?.abortController as AbortController;

    buildBackgroundTaskAbortHook("task_hook_completed", controller)();
    await Bun.sleep(20);

    // Restore only reclaims rows the interrupt errored; a row that settled
    // on its own keeps its terminal state.
    expect(
      getSubagents().find((a) => a.id === "sub_task_hook_completed")?.status,
    ).toBe("completed");
    cancel.mockRestore();
  });
});
