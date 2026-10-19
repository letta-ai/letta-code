/**
 * Interrupt hook for a background Task: route through TaskStop semantics
 * (remote workers/runs, process cleanup), falling back to a local abort.
 */
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
  // Snapshot at registration: remote-ness and the subagent row id never
  // change for a task's lifetime. Remote killed:false preserves the retry
  // handle; only local fail-safe aborts.
  const bgTask = backgroundTasks.get(taskId);
  const remote = bgTask?.remote ?? false;
  const failSafeAbort = () => !remote && abortController.abort();
  const hook = () => {
    void import("./task-stop.js")
      .then((m) => m.task_stop({ task_id: taskId }))
      .then((result) => {
        if (!result.killed) failSafeAbort();
        // A failed remote cancel must not strand the task: the interrupt
        // already marked the subagent row errored (removal next turn),
        // which destroys the conversationId a TaskStop retry needs.
        if (remote && !result.killed && bgTask) {
          restoreInterruptedSubagentRow(bgTask.subagentId, hook);
        }
      })
      .catch(() => {
        failSafeAbort();
        if (remote && bgTask) {
          restoreInterruptedSubagentRow(bgTask.subagentId, hook);
        }
      });
  };
  return hook;
}

/**
 * Undo an interrupt's errored marking when its cancel could not land (a
 * remote TaskStop that failed): keeps the row — and the conversationId a
 * retry needs — alive, and re-arms the hook so a later interrupt retries.
 * Rows that settled any other way keep their state.
 */
function restoreInterruptedSubagentRow(
  subagentId: string,
  hook: () => void,
): void {
  const row = getSubagents().find((agent) => agent.id === subagentId);
  if (!row || row.status !== "error") return;
  updateSubagent(subagentId, { status: "running", error: undefined });
  registerSubagentAbortHook(subagentId, hook);
}
