import { kill_bash } from "./KillBash.js";
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
}

export async function task_stop(args: TaskStopArgs): Promise<TaskStopResult> {
  validateRequiredParams(args, ["task_id"], "TaskStop");
  const { task_id } = args;

  // Check if this is a background Task (subagent)
  const task = backgroundTasks.get(task_id);
  if (task) {
    if (task.status === "running" && task.abortController) {
      task.abortController.abort();
      task.status = "failed";
      task.error = "Aborted by user";
      scheduleBackgroundTaskCleanup(task_id);
      return { killed: true };
    }
    // Task exists but isn't running or doesn't have abort controller
    return { killed: false };
  }

  // Fall back to killing a Bash background process.
  // The KillBash helper still uses `shell_id` internally; task_id is the
  // unified external contract (bash shells share the same id space).
  return kill_bash({ shell_id: task_id });
}
