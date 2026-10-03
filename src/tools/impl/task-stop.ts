import { killBackgroundProcess } from "./kill-bash.js";
import {
  backgroundTasks,
  scheduleBackgroundTaskCleanup,
} from "./process_manager.js";
import { validateRequiredParams } from "./validation.js";

interface TaskStopArgs {
  task_id: string;
}

interface TaskStopResult {
  killed: boolean;
  output?: string;
}

export async function task_stop(args: TaskStopArgs): Promise<TaskStopResult> {
  validateRequiredParams(args, ["task_id"], "TaskStop");
  const { task_id } = args;

  // Check if this is a background Task (subagent)
  const task = backgroundTasks.get(task_id);
  if (task) {
    if (task.status === "running" && task.abortController) {
      task.abortController.abort();
      task.error = "Aborted by user";
      await task.completion;
      task.status = "failed";
      scheduleBackgroundTaskCleanup(task_id);
      if (task.remoteStop === "stopped")
        return { killed: true, output: "Remote subagent stopped" };
      if (task.remoteStop === "unconfirmed")
        return {
          killed: false,
          output:
            "Cancel requested for the remote subagent, not yet confirmed: its Cloud run may still be running",
        };
      return { killed: true };
    }
    // Task exists but isn't running or doesn't have abort controller
    return { killed: false };
  }

  // Fall back to killing a Bash background process (bash shells share the
  // task id space).
  return { killed: killBackgroundProcess(task_id) };
}
