import { afterEach, expect, spyOn, test } from "bun:test";
import {
  clearAllSubagents,
  registerSubagent,
  updateSubagent,
} from "@/agent/subagent-state";
import { getBackend } from "@/backend";
import { ApiRequestError } from "@/backend/api/request";
import { backgroundTasks } from "./process_manager";
import { task_stop } from "./task-stop";
import * as wakes from "./wake";

function listenerTask() {
  registerSubagent("child", "general-purpose", "child");
  updateSubagent("child", { conversationId: "conv-child" });
  const task = {
    description: "child",
    subagentType: "general-purpose",
    subagentId: "child",
    status: "running" as const,
    startTime: new Date(),
    outputFile: "unused",
    abortController: new AbortController(),
    completion: Promise.resolve(),
    remote: false,
  };
  backgroundTasks.set("task-child", task);
  return task;
}

afterEach(() => {
  backgroundTasks.clear();
  clearAllSubagents();
});

test("a child with no environment still cancels its conversation", async () => {
  const cancel = spyOn(getBackend(), "cancelConversation").mockResolvedValue({
    "run-child": "cancelled",
  });
  try {
    const task = listenerTask();
    expect((await task_stop({ task_id: "task-child" })).killed).toBe(true);
    expect(cancel).toHaveBeenCalledWith("conv-child");
    expect(task.abortController.signal.aborted).toBe(true);
  } finally {
    cancel.mockRestore();
  }
});

test("an unconfirmed cancel preserves a remote child's retry handle", async () => {
  const cancel = spyOn(getBackend(), "cancelConversation").mockResolvedValue({
    "run-child": "failed",
  });
  try {
    const task = listenerTask();
    task.remote = true;
    expect(await task_stop({ task_id: "task-child" })).toMatchObject({
      killed: false,
    });
    expect(task.abortController.signal.aborted).toBe(false);
    expect(task.status).toBe("running");
  } finally {
    cancel.mockRestore();
  }
});

test("TaskStop awaits the owning listener acknowledgement before aborting its waiter", async () => {
  const task = listenerTask();
  let acknowledge!: () => void;
  const acknowledgement = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const stored = backgroundTasks.get("task-child");
  if (!stored) throw new Error("Missing task");
  stored.stop = () => acknowledgement;
  const stopped = task_stop({ task_id: "task-child" });
  await Promise.resolve();
  expect(task.abortController.signal.aborted).toBe(false);
  acknowledge();
  expect(await stopped).toEqual({ killed: true });
  expect(task.abortController.signal.aborted).toBe(true);
});

test("a rejected listener stop returns its reason without claiming a kill", async () => {
  const task = listenerTask();
  const stored = backgroundTasks.get("task-child");
  if (!stored) throw new Error("Missing task");
  stored.stop = async () => {
    throw new Error("Listener offline");
  };
  expect(await task_stop({ task_id: "task-child" })).toEqual({
    killed: false,
    output: "Listener offline",
  });
  expect(task.abortController.signal.aborted).toBe(false);
});

test("a stuck listener acknowledgement keeps the stop bounded and preserves the retry handle", async () => {
  const task = listenerTask();
  const stored = backgroundTasks.get("task-child");
  if (!stored) throw new Error("Missing task");
  stored.stop = () => new Promise(() => {});
  const result = await task_stop(
    { task_id: "task-child" },
    { remoteStopTimeoutMs: 20 },
  );
  expect(result.killed).toBe(false);
  expect(result.output).toContain("may still be running");
  expect(task.abortController.signal.aborted).toBe(false);
});

for (const idle of ["empty", "409"] as const) {
  test(`a local child between runs (${idle}) still aborts without a completion handle`, async () => {
    const cancel = spyOn(getBackend(), "cancelConversation");
    if (idle === "empty") cancel.mockResolvedValue({});
    else
      cancel.mockRejectedValue(new ApiRequestError("No active run", 409, ""));
    try {
      const task = listenerTask();
      delete backgroundTasks.get("task-child")?.completion;
      expect((await task_stop({ task_id: "task-child" })).killed).toBe(true);
      expect(task.abortController.signal.aborted).toBe(true);
      expect(backgroundTasks.get("task-child")?.status).toBe("failed");
    } finally {
      cancel.mockRestore();
    }
  });
}

test("a remote child without completion cannot claim confirmed exit", async () => {
  const cancel = spyOn(getBackend(), "cancelConversation").mockResolvedValue({
    "run-child": "cancelled",
  });
  try {
    const task = listenerTask();
    task.remote = true;
    delete backgroundTasks.get("task-child")?.completion;
    expect(await task_stop({ task_id: "task-child" })).toMatchObject({
      killed: false,
      output: "Subagent process exit cannot be confirmed",
    });
  } finally {
    cancel.mockRestore();
  }
});

for (const idle of ["empty", "409"] as const) {
  test(`an idle remote child (${idle}) still needs cancellation confirmation`, async () => {
    const cancel = spyOn(getBackend(), "cancelConversation");
    if (idle === "empty") cancel.mockResolvedValue({});
    else
      cancel.mockRejectedValue(new ApiRequestError("No active run", 409, ""));
    try {
      const task = listenerTask();
      task.remote = true;
      expect((await task_stop({ task_id: "task-child" })).killed).toBe(false);
      expect(task.abortController.signal.aborted).toBe(false);
      expect(task.status).toBe("running");
    } finally {
      cancel.mockRestore();
    }
  });
}

test("wake cleanup failure records process exit and retries only wakes on the same task ID", async () => {
  const cancel = spyOn(getBackend(), "cancelConversation").mockResolvedValue(
    {},
  );
  const cancelWakes = spyOn(wakes, "cancelConversationWakes")
    .mockRejectedValueOnce(new Error("Schedules unavailable"))
    .mockRejectedValueOnce(new Error("Schedules unavailable"))
    .mockResolvedValueOnce();
  const task = listenerTask();
  updateSubagent("child", { agentId: "agent-child" });
  const abort = spyOn(task.abortController, "abort");
  try {
    expect(await task_stop({ task_id: "task-child" })).toMatchObject({
      killed: false,
      output: expect.stringContaining(
        "process stopped, but its wakes could not be cancelled",
      ),
    });
    expect(backgroundTasks.get("task-child")?.status).toBe("failed");
    expect(backgroundTasks.get("task-child")?.cleanupTimer).toBeDefined();
    expect(cancelWakes).toHaveBeenCalledTimes(2);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(await task_stop({ task_id: "task-child" })).toEqual({
      killed: true,
    });
    expect(cancelWakes).toHaveBeenCalledTimes(3);
    expect(cancelWakes).toHaveBeenLastCalledWith({
      agentId: "agent-child",
      conversationId: "conv-child",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
  } finally {
    abort.mockRestore();
    cancelWakes.mockRestore();
    cancel.mockRestore();
  }
});
