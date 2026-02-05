import { backgroundProcesses, backgroundTasks } from "./process_manager.js";
import { LIMITS, truncateByChars } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";

interface GetTaskOutputArgs {
  task_id: string;
  block?: boolean;
  timeout?: number;
  filter?: string;
}

interface GetTaskOutputResult {
  message: string;
  status?: "running" | "completed" | "failed";
}

/**
 * Core implementation for retrieving task/process output.
 * Used by both BashOutput (legacy) and TaskOutput (new).
 * Checks both backgroundProcesses (Bash) and backgroundTasks (Task).
 */
export async function getTaskOutput(
  args: GetTaskOutputArgs,
): Promise<GetTaskOutputResult> {
  const { task_id, block = false, timeout = 30000, filter } = args;

  // Check backgroundProcesses first (for Bash background commands)
  const proc = backgroundProcesses.get(task_id);
  if (proc) {
    return getProcessOutput(task_id, proc, block, timeout, filter);
  }

  // Check backgroundTasks (for Task background subagents)
  const task = backgroundTasks.get(task_id);
  if (task) {
    return getBackgroundTaskOutput(task_id, task, block, timeout, filter);
  }

  return { message: `No background process found with ID: ${task_id}` };
}

/**
 * Get output from a background Bash process.
 */
async function getProcessOutput(
  task_id: string,
  proc: (typeof backgroundProcesses extends Map<string, infer V> ? V : never),
  block: boolean,
  timeout: number,
  filter?: string,
): Promise<GetTaskOutputResult> {
  // If blocking, wait for process to complete (or timeout)
  if (block && proc.status === "running") {
    const startTime = Date.now();
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        const currentProc = backgroundProcesses.get(task_id);
        if (!currentProc || currentProc.status !== "running") {
          clearInterval(checkInterval);
          resolve();
        } else if (Date.now() - startTime >= timeout) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100); // Check every 100ms
    });
  }

  // Re-fetch in case status changed while waiting
  const currentProc = backgroundProcesses.get(task_id);
  if (!currentProc) {
    return { message: `Process ${task_id} no longer exists` };
  }

  const stdout = currentProc.stdout.join("\n");
  const stderr = currentProc.stderr.join("\n");
  let text = stdout;
  if (stderr) text = text ? `${text}\n${stderr}` : stderr;

  if (filter) {
    text = text
      .split("\n")
      .filter((line) => line.includes(filter))
      .join("\n");
  }

  const userCwd = process.env.USER_CWD || process.cwd();

  // Apply character limit to prevent excessive token usage
  const { content: truncatedOutput } = truncateByChars(
    text || "(no output yet)",
    LIMITS.BASH_OUTPUT_CHARS,
    "TaskOutput",
    { workingDirectory: userCwd, toolName: "TaskOutput" },
  );

  return {
    message: truncatedOutput,
    status: currentProc.status,
  };
}

/**
 * Get output from a background Task (subagent).
 */
async function getBackgroundTaskOutput(
  task_id: string,
  task: (typeof backgroundTasks extends Map<string, infer V> ? V : never),
  block: boolean,
  timeout: number,
  filter?: string,
): Promise<GetTaskOutputResult> {
  // If blocking, wait for task to complete (or timeout)
  if (block && task.status === "running") {
    const startTime = Date.now();
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        const currentTask = backgroundTasks.get(task_id);
        if (!currentTask || currentTask.status !== "running") {
          clearInterval(checkInterval);
          resolve();
        } else if (Date.now() - startTime >= timeout) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100); // Check every 100ms
    });
  }

  // Re-fetch in case status changed while waiting
  const currentTask = backgroundTasks.get(task_id);
  if (!currentTask) {
    return { message: `Task ${task_id} no longer exists` };
  }

  let text = currentTask.output.join("\n");
  if (currentTask.error) {
    text = text ? `${text}\n[error] ${currentTask.error}` : `[error] ${currentTask.error}`;
  }

  if (filter) {
    text = text
      .split("\n")
      .filter((line) => line.includes(filter))
      .join("\n");
  }

  const userCwd = process.env.USER_CWD || process.cwd();

  // Apply character limit to prevent excessive token usage
  const { content: truncatedOutput } = truncateByChars(
    text || "(no output yet)",
    LIMITS.TASK_OUTPUT_CHARS,
    "TaskOutput",
    { workingDirectory: userCwd, toolName: "TaskOutput" },
  );

  return {
    message: truncatedOutput,
    status: currentTask.status,
  };
}

// Legacy BashOutput interface
interface BashOutputArgs {
  shell_id: string;
  filter?: string;
}

interface BashOutputResult {
  message: string;
}

/**
 * Legacy BashOutput function - wraps getTaskOutput with non-blocking behavior.
 */
export async function bash_output(
  args: BashOutputArgs,
): Promise<BashOutputResult> {
  validateRequiredParams(args, ["shell_id"], "BashOutput");
  const { shell_id, filter } = args;

  const result = await getTaskOutput({
    task_id: shell_id,
    block: false, // BashOutput is always non-blocking (legacy behavior)
    filter,
  });

  return { message: result.message };
}
