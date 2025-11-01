import type { ExecOptions } from "node:child_process";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { backgroundProcesses, getNextBashId } from "./process_manager.js";
import { LIMITS, truncateByChars } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";

const execAsync = promisify(exec);

interface BashArgs {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
}

interface BashResult {
  content: Array<{
    type: string;
    text: string;
  }>;
  isError?: boolean;
}

export async function bash(args: BashArgs): Promise<BashResult> {
  validateRequiredParams(args, ["command"], "Bash");
  const {
    command,
    timeout = 120000,
    description: _description,
    run_in_background = false,
  } = args;
  const userCwd = process.env.USER_CWD || process.cwd();

  if (command === "/bashes") {
    const processes = Array.from(backgroundProcesses.entries());
    if (processes.length === 0) {
      return { content: [{ type: "text", text: "(no content)" }] };
    }
    let output = "";
    for (const [id, proc] of processes) {
      const runtime = proc.startTime
        ? `${Math.floor((Date.now() - proc.startTime.getTime()) / 1000)}s`
        : "unknown";
      output += `${id}: ${proc.command} (${proc.status}, runtime: ${runtime})\n`;
    }
    return { content: [{ type: "text", text: output.trim() }] };
  }

  if (run_in_background) {
    const bashId = getNextBashId();
    const childProcess = spawn(command, [], {
      shell: true,
      cwd: userCwd,
      env: { ...process.env },
    });
    backgroundProcesses.set(bashId, {
      process: childProcess,
      command,
      stdout: [],
      stderr: [],
      status: "running",
      exitCode: null,
      lastReadIndex: { stdout: 0, stderr: 0 },
      startTime: new Date(),
    });
    const bgProcess = backgroundProcesses.get(bashId);
    if (!bgProcess) {
      throw new Error("Failed to track background process state");
    }
    childProcess.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      bgProcess.stdout.push(...lines);
    });
    childProcess.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      bgProcess.stderr.push(...lines);
    });
    childProcess.on("exit", (code: number | null) => {
      bgProcess.status = code === 0 ? "completed" : "failed";
      bgProcess.exitCode = code;
    });
    childProcess.on("error", (err: Error) => {
      bgProcess.status = "failed";
      bgProcess.stderr.push(err.message);
    });
    if (timeout && timeout > 0) {
      setTimeout(() => {
        if (bgProcess.status === "running") {
          childProcess.kill("SIGTERM");
          bgProcess.status = "failed";
          bgProcess.stderr.push(`Command timed out after ${timeout}ms`);
        }
      }, timeout);
    }
    return {
      content: [
        {
          type: "text",
          text: `Command running in background with ID: ${bashId}`,
        },
      ],
    };
  }

  const effectiveTimeout = Math.min(Math.max(timeout, 1), 600000);
  try {
    const options: ExecOptions = {
      timeout: effectiveTimeout,
      maxBuffer: 10 * 1024 * 1024,
      cwd: userCwd,
      env: { ...process.env },
    };
    const { stdout, stderr } = await execAsync(command, options);
    const stdoutStr = typeof stdout === "string" ? stdout : stdout.toString();
    const stderrStr = typeof stderr === "string" ? stderr : stderr.toString();
    let output = stdoutStr;
    if (stderrStr) output = output ? `${output}\n${stderrStr}` : stderrStr;

    // Apply character limit to prevent excessive token usage
    const { content: truncatedOutput } = truncateByChars(
      output || "(Command completed with no output)",
      LIMITS.BASH_OUTPUT_CHARS,
      "Bash",
    );

    return {
      content: [{ type: "text", text: truncatedOutput }],
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    let errorMessage = "";
    if (err.killed && err.signal === "SIGTERM")
      errorMessage = `Command timed out after ${effectiveTimeout}ms\n`;
    if (err.code) errorMessage += `Exit code: ${err.code}\n`;
    if (err.stderr) errorMessage += err.stderr;
    else if (err.message) errorMessage += err.message;
    if (err.stdout) errorMessage = `${err.stdout}\n${errorMessage}`;

    // Apply character limit even to error messages
    const { content: truncatedError } = truncateByChars(
      errorMessage.trim() || "Command failed with unknown error",
      LIMITS.BASH_OUTPUT_CHARS,
      "Bash",
    );

    return {
      content: [{ type: "text", text: truncatedError }],
      isError: true,
    };
  }
}
