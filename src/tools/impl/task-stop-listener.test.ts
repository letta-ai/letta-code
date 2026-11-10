import { afterEach, expect, spyOn, test } from "bun:test";
import {
  clearAllSubagents,
  registerSubagent,
  updateSubagent,
} from "@/agent/subagent-state";
import { getBackend } from "@/backend";
import { backgroundTasks } from "./process_manager";
import { task_stop } from "./task-stop";

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

test("an unconfirmed cancel preserves the local child's retry handle", async () => {
  const cancel = spyOn(getBackend(), "cancelConversation").mockResolvedValue({
    "run-child": "failed",
  });
  try {
    const task = listenerTask();
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
