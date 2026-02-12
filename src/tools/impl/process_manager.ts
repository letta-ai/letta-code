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
}

export const backgroundProcesses = new Map<string, BackgroundProcess>();
export const backgroundTasks = new Map<string, BackgroundTask>();
let bashIdCounter = 1;
export const getNextBashId = () => `bash_${bashIdCounter++}`;

let taskIdCounter = 1;
export const getNextTaskId = () => `task_${taskIdCounter++}`;

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
