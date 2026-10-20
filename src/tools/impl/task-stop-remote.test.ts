import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  __resetCompletedSubagentRetentionMsForTests,
  __setCompletedSubagentRetentionMsForTests,
  clearAllSubagents,
  clearCompletedSubagents,
  clearSubagentsByIds,
  completeSubagent,
  getSubagents,
  interruptActiveSubagents,
  interruptStopFailedSubagents,
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

  test("keeps the retry row through a turn-start cleanup while the cancel is in flight", async () => {
    let resolveCancel!: (value: Record<string, string>) => void;
    const cancel = spyOn(getBackend(), "cancelConversation").mockImplementation(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    startRemoteTask("task_hook_race", "conv-child");
    const controller = backgroundTasks.get("task_hook_race")
      ?.abortController as AbortController;
    registerSubagentAbortHook(
      "sub_task_hook_race",
      buildBackgroundTaskAbortHook("task_hook_race", controller),
    );

    interruptActiveSubagents("Interrupted by user");
    // Let the hook reach cancelConversation so the cancel is genuinely in
    // flight before the new turn starts.
    await Bun.sleep(20);
    // The user starts a new turn while the cancel is still in flight: the
    // turn-start sweep must not delete the row that holds the remote run's
    // only retry handle.
    clearCompletedSubagents();
    expect(getSubagents().some((a) => a.id === "sub_task_hook_race")).toBe(
      true,
    );

    // The cancel fails: the protected row is restored and stays retryable.
    resolveCancel({ "run-child": "failed" });
    await Bun.sleep(20);
    expect(
      getSubagents().find((a) => a.id === "sub_task_hook_race")?.status,
    ).toBe("running");
    cancel.mockRestore();
  });

  test("keeps the retry row through the terminal-row cleanup timer while the cancel is in flight", async () => {
    __setCompletedSubagentRetentionMsForTests(10);
    try {
      let resolveCancel!: (value: Record<string, string>) => void;
      const cancel = spyOn(
        getBackend(),
        "cancelConversation",
      ).mockImplementation(
        () =>
          new Promise<Record<string, string>>((resolve) => {
            resolveCancel = resolve;
          }),
      );
      startRemoteTask("task_hook_timer", "conv-child");
      const controller = backgroundTasks.get("task_hook_timer")
        ?.abortController as AbortController;
      registerSubagentAbortHook(
        "sub_task_hook_timer",
        buildBackgroundTaskAbortHook("task_hook_timer", controller),
      );

      interruptActiveSubagents("Interrupted by user");
      // Several retention windows elapse while the cancel is in flight:
      // the timer must keep re-checking instead of deleting the row.
      await Bun.sleep(35);
      expect(getSubagents().some((a) => a.id === "sub_task_hook_timer")).toBe(
        true,
      );

      resolveCancel({ "run-child": "failed" });
      await Bun.sleep(20);
      expect(
        getSubagents().find((a) => a.id === "sub_task_hook_timer")?.status,
      ).toBe("running");
      cancel.mockRestore();
    } finally {
      __resetCompletedSubagentRetentionMsForTests();
    }
  });

  test("does not resurrect a task that failed naturally while its cancel was in flight", async () => {
    let resolveCancel!: (value: Record<string, string>) => void;
    const cancel = spyOn(getBackend(), "cancelConversation").mockImplementation(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    startRemoteTask("task_hook_natural", "conv-child");
    const controller = backgroundTasks.get("task_hook_natural")
      ?.abortController as AbortController;
    registerSubagentAbortHook(
      "sub_task_hook_natural",
      buildBackgroundTaskAbortHook("task_hook_natural", controller),
    );

    interruptActiveSubagents("Interrupted by user");
    // Let the hook reach cancelConversation so the cancel is genuinely in
    // flight when the task fails on its own.
    await Bun.sleep(20);
    // The task fails on its own while the cancel is in flight: settlement
    // marks the background task failed and writes the real error.
    const bgTask = backgroundTasks.get("task_hook_natural");
    bgTask!.status = "failed";
    completeSubagent("sub_task_hook_natural", {
      success: false,
      error: "natural failure",
    });

    resolveCancel({ "run-child": "failed" });
    await Bun.sleep(20);
    // The natural failure stands: no running ghost, no re-armed hook, and
    // the row no longer blocks terminal-row cleanup.
    const row = getSubagents().find((a) => a.id === "sub_task_hook_natural");
    expect(row?.status).toBe("error");
    expect(row?.error).toBe("natural failure");
    expect(row?.cancelPending).toBeUndefined();
    clearCompletedSubagents();
    expect(getSubagents().some((a) => a.id === "sub_task_hook_natural")).toBe(
      false,
    );
    cancel.mockRestore();
  });

  test("keeps the retry row through static-transcript promotion while the cancel is in flight", async () => {
    let resolveCancel!: (value: Record<string, string>) => void;
    const cancel = spyOn(getBackend(), "cancelConversation").mockImplementation(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    startRemoteTask("task_hook_promote", "conv-child");
    const controller = backgroundTasks.get("task_hook_promote")
      ?.abortController as AbortController;
    registerSubagentAbortHook(
      "sub_task_hook_promote",
      buildBackgroundTaskAbortHook("task_hook_promote", controller),
    );

    interruptActiveSubagents("Interrupted by user");
    // Let the hook reach cancelConversation so the cancel is genuinely in
    // flight before the promotion runs.
    await Bun.sleep(20);
    // Esc's refreshDerived promotes the finished Task line to the static
    // transcript and clears the backing rows — the third deletion path.
    clearSubagentsByIds(["sub_task_hook_promote"]);
    const retained = getSubagents().find(
      (a) => a.id === "sub_task_hook_promote",
    );
    // The row survives as a hidden retry handle: its line was promoted, so
    // it must not double-render in the live subagent display.
    expect(retained).toBeDefined();
    expect(retained?.silent).toBe(true);

    // The cancel fails: the retained row is restored and a later interrupt
    // retries through it.
    resolveCancel({ "run-child": "failed" });
    await Bun.sleep(20);
    expect(
      getSubagents().find((a) => a.id === "sub_task_hook_promote")?.status,
    ).toBe("running");
    interruptActiveSubagents("Interrupted by user");
    await Bun.sleep(20);
    expect(cancel).toHaveBeenCalledTimes(2);
    cancel.mockRestore();
  });

  test("releases a promoted row to cleanup once its cancel lands", async () => {
    let resolveCancel!: (value: Record<string, string>) => void;
    const cancel = spyOn(getBackend(), "cancelConversation").mockImplementation(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    startRemoteTask("task_hook_promote_ok", "conv-child");
    const controller = backgroundTasks.get("task_hook_promote_ok")
      ?.abortController as AbortController;
    registerSubagentAbortHook(
      "sub_task_hook_promote_ok",
      buildBackgroundTaskAbortHook("task_hook_promote_ok", controller),
    );

    interruptActiveSubagents("Interrupted by user");
    await Bun.sleep(20);
    clearSubagentsByIds(["sub_task_hook_promote_ok"]);
    expect(
      getSubagents().find((a) => a.id === "sub_task_hook_promote_ok")?.silent,
    ).toBe(true);

    // The cancel lands: the flag clears and the hidden terminal row is
    // cleanup-eligible again — retention is bounded, not a leak.
    resolveCancel({ "run-child": "cancelled" });
    await Bun.sleep(20);
    clearCompletedSubagents();
    expect(
      getSubagents().some((a) => a.id === "sub_task_hook_promote_ok"),
    ).toBe(false);
    cancel.mockRestore();
  });

  test("marks a restored row stop-failed so the UI can surface and retry it", async () => {
    let resolveCancel!: (value: Record<string, string>) => void;
    const cancel = spyOn(getBackend(), "cancelConversation").mockImplementation(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    startRemoteTask("task_hook_stopfail", "conv-child");
    const controller = backgroundTasks.get("task_hook_stopfail")
      ?.abortController as AbortController;
    registerSubagentAbortHook(
      "sub_task_hook_stopfail",
      buildBackgroundTaskAbortHook("task_hook_stopfail", controller),
    );

    interruptActiveSubagents("Interrupted by user");
    await Bun.sleep(20);
    // The cancel fails: the row restores as the retry handle, marked
    // stop-failed so the transcript surfaces the live remote run and idle
    // Esc can retry its stop.
    resolveCancel({ "run-child": "failed" });
    await Bun.sleep(20);
    const restored = getSubagents().find(
      (a) => a.id === "sub_task_hook_stopfail",
    );
    expect(restored?.status).toBe("running");
    expect(restored?.stopFailed).toBe(true);
    cancel.mockRestore();
  });

  test("clears stopFailed when a later stop lands", async () => {
    let resolveCancel!: (value: Record<string, string>) => void;
    const cancel = spyOn(getBackend(), "cancelConversation").mockImplementation(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    startRemoteTask("task_hook_stopfail_ok", "conv-child");
    const controller = backgroundTasks.get("task_hook_stopfail_ok")
      ?.abortController as AbortController;
    registerSubagentAbortHook(
      "sub_task_hook_stopfail_ok",
      buildBackgroundTaskAbortHook("task_hook_stopfail_ok", controller),
    );

    interruptActiveSubagents("Interrupted by user");
    await Bun.sleep(20);
    resolveCancel({ "run-child": "failed" });
    await Bun.sleep(20);
    expect(
      getSubagents().find((a) => a.id === "sub_task_hook_stopfail_ok")
        ?.stopFailed,
    ).toBe(true);

    // A later stop lands: the row settles as a plain terminal row — no
    // lingering stopFailed marking keeps idle Esc or notifications armed.
    interruptActiveSubagents("Interrupted by user");
    await Bun.sleep(20);
    resolveCancel({ "run-child": "cancelled" });
    await Bun.sleep(20);
    const settled = getSubagents().find(
      (a) => a.id === "sub_task_hook_stopfail_ok",
    );
    expect(settled?.status).toBe("error");
    expect(settled?.stopFailed).toBeUndefined();
    expect(settled?.cancelPending).toBeUndefined();
    clearCompletedSubagents();
    expect(
      getSubagents().some((a) => a.id === "sub_task_hook_stopfail_ok"),
    ).toBe(false);
    cancel.mockRestore();
  });

  test("clears stopFailed when the task completes naturally", async () => {
    let resolveCancel!: (value: Record<string, string>) => void;
    const cancel = spyOn(getBackend(), "cancelConversation").mockImplementation(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    startRemoteTask("task_hook_stopfail_natural", "conv-child");
    const controller = backgroundTasks.get("task_hook_stopfail_natural")
      ?.abortController as AbortController;
    registerSubagentAbortHook(
      "sub_task_hook_stopfail_natural",
      buildBackgroundTaskAbortHook("task_hook_stopfail_natural", controller),
    );

    interruptActiveSubagents("Interrupted by user");
    await Bun.sleep(20);
    resolveCancel({ "run-child": "failed" });
    await Bun.sleep(20);
    expect(
      getSubagents().find((a) => a.id === "sub_task_hook_stopfail_natural")
        ?.stopFailed,
    ).toBe(true);

    // The run finishes on its own while armed for a retry: the natural
    // result stands and no stop-failed marking survives it.
    completeSubagent("sub_task_hook_stopfail_natural", {
      success: true,
      result: "done",
    });
    const settled = getSubagents().find(
      (a) => a.id === "sub_task_hook_stopfail_natural",
    );
    expect(settled?.status).toBe("completed");
    expect(settled?.stopFailed).toBeUndefined();
    cancel.mockRestore();
  });

  test("a fresh interrupt supersedes the recorded stop failure", async () => {
    let resolveCancel!: (value: Record<string, string>) => void;
    const cancel = spyOn(getBackend(), "cancelConversation").mockImplementation(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    startRemoteTask("task_hook_supersede", "conv-child");
    const controller = backgroundTasks.get("task_hook_supersede")
      ?.abortController as AbortController;
    registerSubagentAbortHook(
      "sub_task_hook_supersede",
      buildBackgroundTaskAbortHook("task_hook_supersede", controller),
    );

    interruptActiveSubagents("Interrupted by user");
    await Bun.sleep(20);
    resolveCancel({ "run-child": "failed" });
    await Bun.sleep(20);
    expect(
      getSubagents().find((a) => a.id === "sub_task_hook_supersede")
        ?.stopFailed,
    ).toBe(true);

    // A new stop attempt is in flight: the recorded failure is superseded
    // until the hook settles it (and re-marks only if it fails again).
    interruptActiveSubagents("Interrupted by user");
    await Bun.sleep(20);
    const retrying = getSubagents().find(
      (a) => a.id === "sub_task_hook_supersede",
    );
    expect(retrying?.status).toBe("error");
    expect(retrying?.cancelPending).toBe(true);
    expect(retrying?.stopFailed).toBeUndefined();
    cancel.mockRestore();
  });

  test("an idle Esc retry stops only the failed task, not its healthy sibling", async () => {
    const resolvers = new Map<
      string,
      (value: Record<string, string>) => void
    >();
    const cancel = spyOn(getBackend(), "cancelConversation").mockImplementation(
      (conversationId: string) =>
        new Promise<Record<string, string>>((resolve) => {
          resolvers.set(conversationId, resolve);
        }),
    );
    startRemoteTask("task_hook_failed_one", "conv-child");
    startRemoteTask("task_hook_healthy_one", "conv-other");
    const failedController = backgroundTasks.get("task_hook_failed_one")
      ?.abortController as AbortController;
    const healthyController = backgroundTasks.get("task_hook_healthy_one")
      ?.abortController as AbortController;
    let healthyHookFired = 0;
    registerSubagentAbortHook(
      "sub_task_hook_failed_one",
      buildBackgroundTaskAbortHook("task_hook_failed_one", failedController),
    );
    registerSubagentAbortHook(
      "sub_task_hook_healthy_one",
      buildBackgroundTaskAbortHook("task_hook_healthy_one", healthyController),
    );
    const originalHook = healthyController.abort.bind(healthyController);
    healthyController.abort = () => {
      healthyHookFired += 1;
      return originalHook();
    };

    // First stop fails: only the failed row is marked. The cancels are
    // keyed by conversation so the sibling's cancel stays pending.
    interruptActiveSubagents("Interrupted by user");
    await Bun.sleep(20);
    resolvers.get("conv-child")?.({ "run-child": "failed" });
    await Bun.sleep(20);
    expect(
      getSubagents().find((a) => a.id === "sub_task_hook_failed_one")
        ?.stopFailed,
    ).toBe(true);
    expect(
      getSubagents().find((a) => a.id === "sub_task_hook_healthy_one")?.status,
    ).toBe("error");

    // Restore both rows to live state: the failed one stop-failed, the
    // sibling healthy again (as if its own interrupt had never happened).
    updateSubagent("sub_task_hook_healthy_one", {
      status: "running",
      error: undefined,
      cancelPending: undefined,
    });

    // The targeted retry re-dispatches only the stop-failed row's hook.
    const retried = interruptStopFailedSubagents("Interrupted by user");
    expect(retried).toEqual(["sub_task_hook_failed_one"]);
    expect(healthyHookFired).toBe(0);
    const sibling = getSubagents().find(
      (a) => a.id === "sub_task_hook_healthy_one",
    );
    expect(sibling?.status).toBe("running");
    expect(sibling?.cancelPending).toBeUndefined();
    cancel.mockRestore();
  });

  test("a failed targeted retry re-marks the row for the next retry", async () => {
    let resolveCancel!: (value: Record<string, string>) => void;
    const cancel = spyOn(getBackend(), "cancelConversation").mockImplementation(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    startRemoteTask("task_hook_retry_loop", "conv-child");
    const controller = backgroundTasks.get("task_hook_retry_loop")
      ?.abortController as AbortController;
    registerSubagentAbortHook(
      "sub_task_hook_retry_loop",
      buildBackgroundTaskAbortHook("task_hook_retry_loop", controller),
    );

    interruptActiveSubagents("Interrupted by user");
    await Bun.sleep(20);
    resolveCancel({ "run-child": "failed" });
    await Bun.sleep(20);
    expect(
      getSubagents().find((a) => a.id === "sub_task_hook_retry_loop")
        ?.stopFailed,
    ).toBe(true);

    // The user follows the hint: the targeted retry dispatches, fails
    // again, and the row re-marks stopFailed so the failure can re-surface
    // and the next Esc stays armed.
    const retried = interruptStopFailedSubagents("Interrupted by user");
    expect(retried).toEqual(["sub_task_hook_retry_loop"]);
    await Bun.sleep(20);
    resolveCancel({ "run-child": "failed" });
    await Bun.sleep(20);
    const restored = getSubagents().find(
      (a) => a.id === "sub_task_hook_retry_loop",
    );
    expect(restored?.status).toBe("running");
    expect(restored?.stopFailed).toBe(true);
    cancel.mockRestore();
  });

  test("stop attempts are counted per dispatch and each settle records its outcome", async () => {
    const resolvers = new Map<
      string,
      (value: Record<string, string>) => void
    >();
    const cancel = spyOn(getBackend(), "cancelConversation").mockImplementation(
      (conversationId: string) =>
        new Promise<Record<string, string>>((resolve) => {
          resolvers.set(conversationId, resolve);
        }),
    );
    startRemoteTask("task_hook_outcomes", "conv-child");
    const controller = backgroundTasks.get("task_hook_outcomes")
      ?.abortController as AbortController;
    registerSubagentAbortHook(
      "sub_task_hook_outcomes",
      buildBackgroundTaskAbortHook("task_hook_outcomes", controller),
    );

    // First stop attempt fails: the restore records the failed outcome for
    // attempt 1.
    interruptActiveSubagents("Interrupted by user");
    await Bun.sleep(20);
    resolvers.get("conv-child")?.({ "run-child": "failed" });
    await Bun.sleep(20);
    const restored = getSubagents().find(
      (a) => a.id === "sub_task_hook_outcomes",
    );
    expect(restored?.stopAttempts).toBe(1);
    expect(restored?.stopFailed).toBe(true);
    expect(restored?.stopOutcome).toEqual({ attempt: 1, kind: "failed" });

    // The targeted retry dispatches attempt 2 and the cancel lands: the
    // settle records the stopped outcome for attempt 2.
    const retried = interruptStopFailedSubagents("Interrupted by user");
    expect(retried).toEqual(["sub_task_hook_outcomes"]);
    await Bun.sleep(20);
    resolvers.get("conv-child")?.({ "run-child": "cancelled" });
    await Bun.sleep(20);
    const stopped = getSubagents().find(
      (a) => a.id === "sub_task_hook_outcomes",
    );
    expect(stopped?.stopAttempts).toBe(2);
    expect(stopped?.stopFailed).toBeUndefined();
    expect(stopped?.cancelPending).toBeUndefined();
    expect(stopped?.stopOutcome).toEqual({ attempt: 2, kind: "stopped" });
    cancel.mockRestore();
  });

  test("a natural failure during a retry records the natural outcome, never a stop", async () => {
    const resolvers = new Map<
      string,
      (value: Record<string, string>) => void
    >();
    const cancel = spyOn(getBackend(), "cancelConversation").mockImplementation(
      (conversationId: string) =>
        new Promise<Record<string, string>>((resolve) => {
          resolvers.set(conversationId, resolve);
        }),
    );
    startRemoteTask("task_hook_natural_fail", "conv-child");
    const controller = backgroundTasks.get("task_hook_natural_fail")
      ?.abortController as AbortController;
    registerSubagentAbortHook(
      "sub_task_hook_natural_fail",
      buildBackgroundTaskAbortHook("task_hook_natural_fail", controller),
    );

    // First stop attempt fails and restores the retry handle.
    interruptActiveSubagents("Interrupted by user");
    await Bun.sleep(20);
    resolvers.get("conv-child")?.({ "run-child": "failed" });
    await Bun.sleep(20);
    expect(
      getSubagents().find((a) => a.id === "sub_task_hook_natural_fail")
        ?.stopFailed,
    ).toBe(true);

    // The retry dispatches, but the task fails on its own while the cancel
    // is in flight: the settle must record the natural outcome so the
    // notification selector never mistakes it for a landed stop.
    interruptStopFailedSubagents("Interrupted by user");
    await Bun.sleep(20);
    const bgTask = backgroundTasks.get("task_hook_natural_fail");
    if (bgTask) bgTask.status = "failed";
    resolvers.get("conv-child")?.({ "run-child": "failed" });
    await Bun.sleep(20);
    const settled = getSubagents().find(
      (a) => a.id === "sub_task_hook_natural_fail",
    );
    expect(settled?.stopOutcome).toEqual({ attempt: 2, kind: "natural" });
    expect(settled?.stopFailed).toBeUndefined();
    expect(settled?.cancelPending).toBeUndefined();
    expect(settled?.status).toBe("error");
    cancel.mockRestore();
  });
});
