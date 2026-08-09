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
  const { shell_id } = args;
  const proc = backgroundProcesses.get(shell_id);
  if (!proc || (proc.kind === "monitor" && proc.status !== "running")) {
    return { killed: false };
  }
  const previousStatus = proc.status;
  const previousNotificationSuppression = proc.completionNotificationSuppressed;
  try {
    // The kill below still fires the child's "exit" event; suppress the
    // completion notification so a deliberate stop does not wake the agent.
    proc.completionNotificationSuppressed = true;
    if (proc.kind === "monitor") {
      proc.status = "failed";
    }
    proc.process.kill("SIGTERM");
    clearBackgroundProcessCleanup(shell_id);
    if (proc.kind === "monitor") {
      scheduleBackgroundProcessCleanup(shell_id);
      notifyBackgroundProcessStateChanged(proc.runtimeScope);
    } else {
      backgroundProcesses.delete(shell_id);
    }
    return { killed: true };
  } catch {
    proc.status = previousStatus;
    proc.completionNotificationSuppressed = previousNotificationSuppression;
    return { killed: false };
  }
}
