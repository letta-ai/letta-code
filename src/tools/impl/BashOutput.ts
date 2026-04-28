import { readFileSync, statSync } from "node:fs";
import { getCurrentWorkingDirectory } from "../../runtime-context";
import {
  backgroundProcesses,
  backgroundTasks,
  getBackgroundOutputFileReadBytes,
} from "./process_manager.js";
import { LIMITS, truncateByChars } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";

interface GetTaskOutputArgs {
  task_id: string;
  block?: boolean;
  timeout?: number;
  filter?: string;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  runningMessageWhenNonBlocking?: boolean;
}

interface GetTaskOutputResult {
  message: string;
  status?: "running" | "completed" | "failed";
}

const POLL_INTERVAL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readOutputFile(filePath?: string): {
  content: string | null;
  fallbackNotice?: string;
} {
  if (!filePath) {
    return { content: null };
  }

  try {
    const stats = statSync(filePath);
    const maxBytes = getBackgroundOutputFileReadBytes();
    if (stats.size > maxBytes) {
      return {
        content: null,
        fallbackNotice: `[Output file too large to load fully here (${stats.size.toLocaleString()} bytes). Showing the bounded in-memory buffer instead. Full transcript: ${filePath}]`,
      };
    }

    return { content: readFileSync(filePath, "utf-8") };
  } catch {
    return { content: null };
  }
}

function getBufferedLineCount(
  proc: typeof backgroundProcesses extends Map<string, infer V> ? V : never,
  stream: "stdout" | "stderr",
): number {
  return stream === "stdout"
    ? (proc.totalStdoutLines ?? proc.stdout.length)
    : (proc.totalStderrLines ?? proc.stderr.length);
}

function getUnreadBufferedLines(
  retainedLines: string[],
  totalLinesSeen: number,
  cursorIndex: number,
): string[] {
  const retainedStart = Math.max(0, totalLinesSeen - retainedLines.length);
  if (cursorIndex <= retainedStart) {
    return retainedLines;
  }

  const sliceStart = Math.max(0, cursorIndex - retainedStart);
  return retainedLines.slice(sliceStart);
}

function emitNewProcessOutput(
  proc: typeof backgroundProcesses extends Map<string, infer V> ? V : never,
  onOutput: (chunk: string, stream: "stdout" | "stderr") => void,
  indexes: { stdout: number; stderr: number },
  filter?: string,
): { stdout: number; stderr: number } {
  const next = { ...indexes };

  const totalStdoutLines = getBufferedLineCount(proc, "stdout");
  if (totalStdoutLines > next.stdout) {
    const newStdoutLines = getUnreadBufferedLines(
      proc.stdout,
      totalStdoutLines,
      next.stdout,
    );
    const filtered = filter
      ? newStdoutLines.filter((line) => line.includes(filter))
      : newStdoutLines;
    if (filtered.length > 0) {
      onOutput(`${filtered.join("\n")}\n`, "stdout");
    }
    next.stdout = totalStdoutLines;
  }

  const totalStderrLines = getBufferedLineCount(proc, "stderr");
  if (totalStderrLines > next.stderr) {
    const newStderrLines = getUnreadBufferedLines(
      proc.stderr,
      totalStderrLines,
      next.stderr,
    );
    const filtered = filter
      ? newStderrLines.filter((line) => line.includes(filter))
      : newStderrLines;
    if (filtered.length > 0) {
      onOutput(`${filtered.join("\n")}\n`, "stderr");
    }
    next.stderr = totalStderrLines;
  }

  return next;
}

function emitNewBackgroundTaskOutput(
  task: typeof backgroundTasks extends Map<string, infer V> ? V : never,
  onOutput: (chunk: string, stream: "stdout" | "stderr") => void,
  cursor: { outputIndex: number; emittedError?: string },
  filter?: string,
): { outputIndex: number; emittedError?: string } {
  const next = { ...cursor };

  if (task.output.length > next.outputIndex) {
    const newOutputLines = task.output.slice(next.outputIndex);
    const filtered = filter
      ? newOutputLines.filter((line) => line.includes(filter))
      : newOutputLines;
    if (filtered.length > 0) {
      onOutput(`${filtered.join("\n")}\n`, "stdout");
    }
    next.outputIndex = task.output.length;
  }

  if (task.error && task.error !== next.emittedError) {
    if (!filter || task.error.includes(filter)) {
      onOutput(`[error] ${task.error}\n`, "stderr");
    }
    next.emittedError = task.error;
  }

  return next;
}

/**
 * Core implementation for retrieving task/process output.
 * Used by both BashOutput (legacy) and TaskOutput (new).
 * Checks both backgroundProcesses (Bash) and backgroundTasks (Task).
 */
export async function getTaskOutput(
  args: GetTaskOutputArgs,
): Promise<GetTaskOutputResult> {
  const {
    task_id,
    block = false,
    timeout = 30000,
    filter,
    onOutput,
    runningMessageWhenNonBlocking = false,
  } = args;

  // Check backgroundProcesses first (for Bash background commands)
  const proc = backgroundProcesses.get(task_id);
  if (proc) {
    return getProcessOutput(
      task_id,
      proc,
      block,
      timeout,
      filter,
      onOutput,
      runningMessageWhenNonBlocking,
    );
  }

  // Check backgroundTasks (for Task background subagents)
  const task = backgroundTasks.get(task_id);
  if (task) {
    return getBackgroundTaskOutput(
      task_id,
      task,
      block,
      timeout,
      filter,
      onOutput,
      runningMessageWhenNonBlocking,
    );
  }

  return { message: `No background process found with ID: ${task_id}` };
}

/**
 * Get output from a background Bash process.
 */
async function getProcessOutput(
  task_id: string,
  proc: typeof backgroundProcesses extends Map<string, infer V> ? V : never,
  block: boolean,
  timeout: number,
  filter?: string,
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void,
  runningMessageWhenNonBlocking?: boolean,
): Promise<GetTaskOutputResult> {
  // If blocking, wait for process to complete (or timeout) while streaming deltas.
  if (block && proc.status === "running") {
    const startTime = Date.now();
    let cursor = { stdout: 0, stderr: 0 };

    if (onOutput) {
      cursor = emitNewProcessOutput(proc, onOutput, cursor, filter);
    }

    while (Date.now() - startTime < timeout) {
      const currentProc = backgroundProcesses.get(task_id);
      if (!currentProc) break;

      if (onOutput) {
        cursor = emitNewProcessOutput(currentProc, onOutput, cursor, filter);
      }

      if (currentProc.status !== "running") {
        break;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    const finalProc = backgroundProcesses.get(task_id);
    if (finalProc && onOutput) {
      emitNewProcessOutput(finalProc, onOutput, cursor, filter);
    }
  }

  // Re-fetch in case status changed while waiting
  const currentProc = backgroundProcesses.get(task_id);
  if (!currentProc) {
    return { message: `Process ${task_id} no longer exists` };
  }

  if (
    !block &&
    runningMessageWhenNonBlocking &&
    currentProc.status === "running"
  ) {
    return { message: "Task is still running...", status: "running" };
  }

  const retainedOutput = readOutputFile(currentProc.outputFile);
  const stdout = currentProc.stdout.join("\n");
  const stderr = currentProc.stderr.join("\n");
  let text =
    retainedOutput.content && retainedOutput.content.length > 0
      ? retainedOutput.content
      : stdout;
  if (
    (!retainedOutput.content || retainedOutput.content.length === 0) &&
    stderr
  ) {
    text = text ? `${text}\n${stderr}` : stderr;
  }
  if (retainedOutput.fallbackNotice) {
    text = text
      ? `${retainedOutput.fallbackNotice}\n${text}`
      : retainedOutput.fallbackNotice;
  }

  if (filter) {
    text = text
      .split("\n")
      .filter((line) => line.includes(filter))
      .join("\n");
  }

  const userCwd = getCurrentWorkingDirectory();

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
  task: typeof backgroundTasks extends Map<string, infer V> ? V : never,
  block: boolean,
  timeout: number,
  filter?: string,
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void,
  runningMessageWhenNonBlocking?: boolean,
): Promise<GetTaskOutputResult> {
  // If blocking, wait for task to complete (or timeout) while streaming deltas.
  if (block && task.status === "running") {
    const startTime = Date.now();
    let cursor: { outputIndex: number; emittedError?: string } = {
      outputIndex: 0,
    };

    if (onOutput) {
      cursor = emitNewBackgroundTaskOutput(task, onOutput, cursor, filter);
    }

    while (Date.now() - startTime < timeout) {
      const currentTask = backgroundTasks.get(task_id);
      if (!currentTask) break;

      if (onOutput) {
        cursor = emitNewBackgroundTaskOutput(
          currentTask,
          onOutput,
          cursor,
          filter,
        );
      }

      if (currentTask.status !== "running") {
        break;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    const finalTask = backgroundTasks.get(task_id);
    if (finalTask && onOutput) {
      emitNewBackgroundTaskOutput(finalTask, onOutput, cursor, filter);
    }
  }

  // Re-fetch in case status changed while waiting
  const currentTask = backgroundTasks.get(task_id);
  if (!currentTask) {
    return { message: `Task ${task_id} no longer exists` };
  }

  if (
    !block &&
    runningMessageWhenNonBlocking &&
    currentTask.status === "running"
  ) {
    return { message: "Task is still running...", status: "running" };
  }

  const retainedOutput = readOutputFile(currentTask.outputFile);
  let text =
    retainedOutput.content && retainedOutput.content.length > 0
      ? retainedOutput.content
      : currentTask.output.join("\n");
  if (
    (!retainedOutput.content || retainedOutput.content.length === 0) &&
    currentTask.error
  ) {
    text = text
      ? `${text}\n[error] ${currentTask.error}`
      : `[error] ${currentTask.error}`;
  }
  if (retainedOutput.fallbackNotice) {
    text = text
      ? `${retainedOutput.fallbackNotice}\n${text}`
      : retainedOutput.fallbackNotice;
  }

  if (filter) {
    text = text
      .split("\n")
      .filter((line) => line.includes(filter))
      .join("\n");
  }

  const userCwd = getCurrentWorkingDirectory();

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
