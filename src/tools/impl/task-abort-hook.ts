import {
  getSubagents,
  registerSubagentAbortHook,
  updateSubagent,
} from "@/agent/subagent-state.js";
import { backgroundTasks } from "./process_manager.js";

export function buildBackgroundTaskAbortHook(
  taskId: string,
  abortController: AbortController,
): () => void {
  const bgTask = backgroundTasks.get(taskId);
  const isRemote = () => Boolean(bgTask?.remote || bgTask?.stop);
  const failSafeAbort = () => !isRemote() && abortController.abort();
  const hook = () => {
    void import("./task-stop.js")
      .then((m) => m.task_stop({ task_id: taskId }))
      .then((result) => {
        if (!result.killed) failSafeAbort();
        settleInterruptedCancel(bgTask, isRemote(), result.killed, hook);
      })
      .catch(() => {
        failSafeAbort();
        settleInterruptedCancel(bgTask, isRemote(), false, hook);
      });
  };
  return hook;
}

function settleInterruptedCancel(
  bgTask: { subagentId: string; status: string } | undefined,
  remote: boolean,
  killed: boolean,
  hook: () => void,
): void {
  if (!bgTask) return;
  const taskLive = bgTask.status === "running";
  if (remote && !killed && taskLive) {
    restoreInterruptedSubagentRow(bgTask.subagentId, hook);
    return;
  }
  const row = getSubagents().find((agent) => agent.id === bgTask.subagentId);
  updateSubagent(bgTask.subagentId, {
    cancelPending: undefined,
    stopFailed: undefined,
    stopOutcome: {
      attempt: row?.stopAttempts ?? 0,
      kind: killed ? "stopped" : "natural",
    },
  });
}

function restoreInterruptedSubagentRow(
  subagentId: string,
  hook: () => void,
): void {
  const row = getSubagents().find((agent) => agent.id === subagentId);
  if (!row || row.status !== "error" || row.result !== undefined) {
    if (row) {
      updateSubagent(subagentId, {
        cancelPending: undefined,
        stopOutcome: { attempt: row.stopAttempts ?? 0, kind: "natural" },
      });
    }
    return;
  }
  updateSubagent(subagentId, {
    status: "running",
    error: undefined,
    cancelPending: undefined,
    stopFailed: true,
    stopOutcome: { attempt: row.stopAttempts ?? 0, kind: "failed" },
  });
  registerSubagentAbortHook(subagentId, hook);
}
