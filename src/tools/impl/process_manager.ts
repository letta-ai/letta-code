type TimerHandle = ReturnType<typeof setTimeout>;

export interface BackgroundProcess {
  process: import("child_process").ChildProcess;
  command: string;
  stdout: string[];
  stderr: string[];
  status: "running" | "completed" | "failed";
  exitCode: number | null;
  lastReadIndex: { stdout: number; stderr: number };
  startTime?: Date;
  outputFile?: string; // File path for persistent output
  totalStdoutLines?: number;
  totalStderrLines?: number;
  cleanupTimer?: TimerHandle;
}

export interface BackgroundTask {
  description: string;
  subagentType: string;
  subagentId: string;
  status: "running" | "completed" | "failed";
  output: string[];
  error?: string;
  startTime: Date;
  outputFile: string;
  abortController?: AbortController;
  cleanupTimer?: TimerHandle;
}

export const backgroundProcesses = new Map<string, BackgroundProcess>();
export const backgroundTasks = new Map<string, BackgroundTask>();
let bashIdCounter = 1;
export const getNextBashId = () => `bash_${bashIdCounter++}`;

let taskIdCounter = 1;
export const getNextTaskId = () => `task_${taskIdCounter++}`;

interface BackgroundRetentionConfig {
  completedEntryTtlMs: number;
  maxProcessLinesPerStream: number;
  maxProcessCharsPerStream: number;
  maxTaskOutputChars: number;
  maxOutputFileReadBytes: number;
  maxRunningProcesses: number;
  maxRunningTasks: number;
}

const DEFAULT_BACKGROUND_RETENTION_CONFIG: BackgroundRetentionConfig = {
  completedEntryTtlMs: 5 * 60 * 1000,
  maxProcessLinesPerStream: 500,
  maxProcessCharsPerStream: 30_000,
  maxTaskOutputChars: 30_000,
  maxOutputFileReadBytes: 1_000_000,
  maxRunningProcesses: 32,
  maxRunningTasks: 32,
};

let backgroundRetentionConfig: BackgroundRetentionConfig = {
  ...DEFAULT_BACKGROUND_RETENTION_CONFIG,
};

function clearCleanupTimer(entry: { cleanupTimer?: TimerHandle }): void {
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = undefined;
  }
}

export function unrefTimer(timer: TimerHandle): void {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref();
  }
}

function scheduleCompletedEntryCleanup<
  T extends {
    status: "running" | "completed" | "failed";
    cleanupTimer?: TimerHandle;
  },
>(entries: Map<string, T>, id: string): void {
  const entry = entries.get(id);
  if (!entry || entry.status === "running") {
    return;
  }

  clearCleanupTimer(entry);
  const timer = setTimeout(() => {
    const current = entries.get(id);
    if (!current || current !== entry || current.status === "running") {
      return;
    }
    clearCleanupTimer(current);
    entries.delete(id);
  }, backgroundRetentionConfig.completedEntryTtlMs);
  unrefTimer(timer);
  entry.cleanupTimer = timer;
}

function trimBufferedLines(lines: string[]): string[] {
  const maxLines = backgroundRetentionConfig.maxProcessLinesPerStream;
  const maxChars = backgroundRetentionConfig.maxProcessCharsPerStream;

  const retained =
    lines.length > maxLines ? lines.slice(-maxLines) : lines.slice();
  let charCount = retained.reduce((sum, line) => sum + line.length + 1, 0);

  while (retained.length > 1 && charCount > maxChars) {
    const removed = retained.shift();
    charCount -= (removed?.length ?? 0) + 1;
  }

  // Keep the most recent tail when a single line is still too long.
  if (retained.length === 1 && charCount > maxChars) {
    const [line] = retained;
    if (line !== undefined) {
      retained[0] = line.slice(-maxChars);
    }
  }

  return retained;
}

function truncateTaskOutput(text: string): string {
  const maxChars = backgroundRetentionConfig.maxTaskOutputChars;
  if (text.length <= maxChars) {
    return text;
  }

  const notice =
    "\n\n[Background task output truncated in memory. See the task output file for the full transcript.]";
  const headLength = Math.max(0, maxChars - notice.length);
  return `${text.slice(0, headLength)}${notice}`;
}

export function __setBackgroundRetentionConfigForTests(
  overrides: Partial<BackgroundRetentionConfig>,
): void {
  backgroundRetentionConfig = {
    ...backgroundRetentionConfig,
    ...overrides,
  };
}

export function __resetBackgroundRetentionConfigForTests(): void {
  backgroundRetentionConfig = {
    ...DEFAULT_BACKGROUND_RETENTION_CONFIG,
  };
}

export function clearBackgroundProcessCleanup(id: string): void {
  const entry = backgroundProcesses.get(id);
  if (entry) {
    clearCleanupTimer(entry);
  }
}

export function clearBackgroundTaskCleanup(id: string): void {
  const entry = backgroundTasks.get(id);
  if (entry) {
    clearCleanupTimer(entry);
  }
}

function countRunningEntries<
  T extends { status: "running" | "completed" | "failed" },
>(entries: Map<string, T>): number {
  let count = 0;
  for (const entry of entries.values()) {
    if (entry.status === "running") {
      count += 1;
    }
  }
  return count;
}

export function getBackgroundOutputFileReadBytes(): number {
  return backgroundRetentionConfig.maxOutputFileReadBytes;
}

export function assertBackgroundProcessCapacity(): void {
  const runningCount = countRunningEntries(backgroundProcesses);
  if (runningCount >= backgroundRetentionConfig.maxRunningProcesses) {
    throw new Error(
      `Too many background processes already running (${runningCount}/${backgroundRetentionConfig.maxRunningProcesses}). Stop one before starting another.`,
    );
  }
}

export function assertBackgroundTaskCapacity(): void {
  const runningCount = countRunningEntries(backgroundTasks);
  if (runningCount >= backgroundRetentionConfig.maxRunningTasks) {
    throw new Error(
      `Too many background tasks already running (${runningCount}/${backgroundRetentionConfig.maxRunningTasks}). Wait for one to finish before starting another.`,
    );
  }
}

export function scheduleBackgroundProcessCleanup(id: string): void {
  scheduleCompletedEntryCleanup(backgroundProcesses, id);
}

export function scheduleBackgroundTaskCleanup(id: string): void {
  scheduleCompletedEntryCleanup(backgroundTasks, id);
}

export function appendBackgroundProcessOutput(
  processState: BackgroundProcess,
  stream: "stdout" | "stderr",
  text: string,
): void {
  const lines = text.split("\n").filter(Boolean);
  if (lines.length === 0) {
    return;
  }

  if (stream === "stdout") {
    processState.totalStdoutLines =
      (processState.totalStdoutLines ?? processState.stdout.length) +
      lines.length;
    processState.stdout.push(...lines);
    processState.stdout = trimBufferedLines(processState.stdout);
    return;
  }

  processState.totalStderrLines =
    (processState.totalStderrLines ?? processState.stderr.length) +
    lines.length;
  processState.stderr.push(...lines);
  processState.stderr = trimBufferedLines(processState.stderr);
}

export function setBackgroundTaskOutput(
  task: BackgroundTask,
  output: string,
): void {
  task.output = output.length > 0 ? [truncateTaskOutput(output)] : [];
}

/**
 * Get a temp directory for background task output files.
 * Uses LETTA_SCRATCHPAD if set, otherwise falls back to os.tmpdir().
 */
export function getBackgroundOutputDir(): string {
  const scratchpad = process.env.LETTA_SCRATCHPAD;
  if (scratchpad) {
    return scratchpad;
  }
  // Fall back to system temp with a letta-specific subdirectory
  const os = require("node:os");
  const path = require("node:path");
  return path.join(os.tmpdir(), "letta-background");
}

/**
 * Create a unique output file path for a background process/task.
 */
export function createBackgroundOutputFile(id: string): string {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = getBackgroundOutputDir();

  // Ensure directory exists
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${id}.log`);
  // Create empty file
  fs.writeFileSync(filePath, "");
  return filePath;
}

/**
 * Append content to a background output file.
 */
export function appendToOutputFile(filePath: string, content: string): void {
  const fs = require("node:fs");
  fs.appendFileSync(filePath, content);
}
