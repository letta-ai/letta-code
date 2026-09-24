import {
  backgroundProcesses,
  clearBackgroundProcessCleanup,
  notifyBackgroundProcessStateChanged,
  scheduleBackgroundProcessCleanup,
} from "./process_manager.js";
import { validateRequiredParams } from "./validation.js";

interface KillBashArgs {
  shell_id: string;
}
interface KillBashResult {
  killed: boolean;
}

export async function kill_bash(args: KillBashArgs): Promise<KillBashResult> {
  validateRequiredParams(args, ["shell_id"], "KillBash");
  return { killed: killBackgroundProcess(args.shell_id) };
}

export function killBackgroundProcess(shell_id: string): boolean {
  const proc = backgroundProcesses.get(shell_id);
  // Monitors and workflows keep their entry after a stop so their status and
  // output file remain available; only a running one can be killed.
  const retainsEntry = proc?.kind === "monitor" || proc?.kind === "workflow";
  if (!proc || (retainsEntry && proc.status !== "running")) {
    return false;
  }
  const previousStatus = proc.status;
  const previousNotificationSuppression = proc.completionNotificationSuppressed;
  try {
    // The kill below still fires the child's "exit" event; suppress the
    // completion notification so a deliberate stop does not wake the agent.
    proc.completionNotificationSuppressed = true;
    if (retainsEntry) {
      proc.status = "failed";
    }
    proc.process.kill("SIGTERM");
    clearBackgroundProcessCleanup(shell_id);
    if (retainsEntry) {
      scheduleBackgroundProcessCleanup(shell_id);
      notifyBackgroundProcessStateChanged(proc.runtimeScope);
    } else {
      backgroundProcesses.delete(shell_id);
    }
    return true;
  } catch {
    proc.status = previousStatus;
    proc.completionNotificationSuppressed = previousNotificationSuppression;
    return false;
  }
}
