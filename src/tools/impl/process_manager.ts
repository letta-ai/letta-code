export interface BackgroundProcess {
  process: import("child_process").ChildProcess;
  command: string;
  stdout: string[];
  stderr: string[];
  status: "running" | "completed" | "failed";
  exitCode: number | null;
  lastReadIndex: { stdout: number; stderr: number };
  startTime?: Date;
}

export const backgroundProcesses = new Map<string, BackgroundProcess>();
let bashIdCounter = 1;
export const getNextBashId = () => `bash_${bashIdCounter++}`;
