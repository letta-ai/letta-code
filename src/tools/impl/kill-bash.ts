import { cancelMonitorBackup } from "./monitor-backup.js";
import { persistMonitorState } from "./monitor-state";
import {
  backgroundProcesses,
  clearBackgroundProcessCleanup,
  notifyBackgroundProcessStateChanged,
  scheduleBackgroundProcessCleanup,
} from "./process_manager.js";

export function killBackgroundProcess(shell_id: string): boolean {
  const proc = backgroundProcesses.get(shell_id);
  // Monitors and workflows keep their entry after a stop so their status and
  // output file remain available; only a running one can be killed.
  const retainsEntry =
    proc?.kind === "monitor" ||
    proc?.kind === "workflow" ||
    proc?.kind === "tool";
  if (!proc || (retainsEntry && proc.status !== "running")) {
    return false;
  }
  const previousStatus = proc.status;
  const previousNotificationSuppression = proc.completionNotificationSuppressed;
  try {
    // The kill below still fires the child's "exit" event; suppress the
    // completion notification so a deliberate stop does not wake the agent.
    proc.completionNotificationSuppressed = true;
    if (proc.kind === "monitor") proc.monitorEndStatus = "stopped";
    if (retainsEntry) {
      proc.status = "failed";
    }
    proc.process.kill("SIGTERM");
    persistMonitorState(proc);
    if (proc.kind === "monitor") void cancelMonitorBackup(shell_id);
    clearBackgroundProcessCleanup(shell_id);
    if (retainsEntry) {
      scheduleBackgroundProcessCleanup(shell_id);
    } else {
      backgroundProcesses.delete(shell_id);
    }
    notifyBackgroundProcessStateChanged(proc.runtimeScope);
    return true;
  } catch {
    proc.monitorEndStatus = undefined;
    proc.status = previousStatus;
    proc.completionNotificationSuppressed = previousNotificationSuppression;
    return false;
  }
}
