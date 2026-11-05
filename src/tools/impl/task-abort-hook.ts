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
        settleInterruptedCancel(bgTask, remote, result.killed, hook);
      })
      .catch(() => {
        failSafeAbort();
        settleInterruptedCancel(bgTask, remote, false, hook);
      });
  };
  return hook;
}

/** Resolve the interrupt's cancelPending marking once the cancel settles.
 * A still-running remote task whose cancel could not land gets its row
 * restored (the conversationId is the only retry handle); every other
 * outcome releases the row to normal terminal-row cleanup. */
function settleInterruptedCancel(
  bgTask: { subagentId: string; status: string } | undefined,
  remote: boolean,
  killed: boolean,
  hook: () => void,
): void {
  if (!bgTask) return;
  // Only a task that is still live has anything to retry: one that settled
  // on its own (natural failure/completion) while the cancel was in flight
  // owns its terminal row, and resurrecting it would create a ghost.
  const taskLive = bgTask.status === "running";
  if (remote && !killed && taskLive) {
    restoreInterruptedSubagentRow(bgTask.subagentId, hook);
    return;
  }
  // The cancel landed, went local, or the task is gone: nothing to retry.
  // Record which outcome happened: killed:true means the backend cancelled
  // every run in the child conversation (task_stop then marks the local
  // wrapper failed as its own success path, so taskLive is already false
  // here), while killed:false on a task that is no longer live means the
  // run settled on its own mid-cancel and must never be reported as a stop.
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

/**
 * Undo an interrupt's errored marking when its cancel could not land (a
 * remote TaskStop that failed): keeps the row — and the conversationId a
 * retry needs — alive, and re-arms the hook so a later interrupt retries.
 * Rows that settled any other way (natural completion or failure) keep
 * their state.
 */
function restoreInterruptedSubagentRow(
  subagentId: string,
  hook: () => void,
): void {
  const row = getSubagents().find((agent) => agent.id === subagentId);
  if (!row || row.status !== "error" || row.result !== undefined) {
    // The row settled on its own or is gone: nothing to reclaim. Release
    // any cancelPending marking so cleanup can proceed, and record the
    // natural outcome so the notification selector never mistakes the
    // row's own settlement for a landed stop.
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
    // The stop failed and the remote run is still live: idle Esc retries
    // through this row, and the UI surfaces the failure instead of letting
    // the promoted "interrupted" line claim the stop succeeded.
    stopFailed: true,
    stopOutcome: { attempt: row.stopAttempts ?? 0, kind: "failed" },
  });
  registerSubagentAbortHook(subagentId, hook);
}
