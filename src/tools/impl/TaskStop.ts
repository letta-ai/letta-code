import { kill_bash } from "./KillBash.js";
import { backgroundTasks } from "./process_manager.js";
import { validateRequiredParams } from "./validation.js";

interface TaskStopArgs {
  task_id?: string;
  shell_id?: string; // deprecated, for backwards compatibility
}

interface TaskStopResult {
  killed: boolean;
}

export async function task_stop(args: TaskStopArgs): Promise<TaskStopResult> {
  // Support both task_id and deprecated shell_id
  let id = args.task_id ?? args.shell_id;
  if (!id) {
    validateRequiredParams(args, ["task_id"], "TaskStop");
    id = ""; // unreachable, validateRequiredParams throws
  }

  // Check if this is a background Task (subagent)
  const task = backgroundTasks.get(id);
  if (task) {
    if (task.status === "running" && task.abortController) {
      task.abortController.abort();
      task.status = "failed";
      task.error = "Aborted by user";
      return { killed: true };
    }
    // Task exists but isn't running or doesn't have abort controller
    return { killed: false };
  }

  // Fall back to killing a Bash background process
  return kill_bash({ shell_id: id });
}
