import { getTaskOutput } from "./BashOutput.js";
import { validateRequiredParams } from "./validation.js";

interface TaskOutputArgs {
  task_id: string;
  block: boolean;
  timeout: number;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}

interface TaskOutputResult {
  message: string;
  status?: "running" | "completed" | "failed";
}

/**
 * TaskOutput - retrieves output from a running or completed background task.
 * `block` and `timeout` are required by the schema (matches Claude Code's
 * current tool contract); callers must pass them explicitly.
 */
export async function task_output(
  args: TaskOutputArgs,
): Promise<TaskOutputResult> {
  validateRequiredParams(args, ["task_id", "block", "timeout"], "TaskOutput");
  const { task_id, block, timeout, onOutput } = args;

  return getTaskOutput({
    task_id,
    block,
    timeout,
    onOutput,
    runningMessageWhenNonBlocking: true,
  });
}
