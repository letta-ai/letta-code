import { getTaskOutput } from "./BashOutput.js";
import { validateRequiredParams } from "./validation.js";

interface TaskOutputArgs {
  task_id: string;
  block?: boolean;
  timeout?: number;
}

interface TaskOutputResult {
  message: string;
  status?: "running" | "completed" | "failed";
}

/**
 * TaskOutput - retrieves output from a running or completed background task.
 * Supports blocking (wait for completion) and timeout.
 */
export async function task_output(
  args: TaskOutputArgs,
): Promise<TaskOutputResult> {
  validateRequiredParams(args, ["task_id"], "TaskOutput");
  const { task_id, block = true, timeout = 30000 } = args;

  return getTaskOutput({
    task_id,
    block,
    timeout,
  });
}
