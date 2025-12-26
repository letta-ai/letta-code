import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { INTERRUPTED_BY_USER } from "../../constants";
import { backgroundProcesses, getNextBashId } from "./process_manager.js";
import { getShellEnv } from "./shellEnv.js";
import { LIMITS, truncateByChars } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";

// Cache the shell configuration
let cachedShellConfig: {
  executable: string;
  args: (cmd: string) => string[];
} | null = null;

/**
 * Get shell configuration for the current platform.
 * Uses spawn with explicit shell executable + args to avoid double-shell parsing issues.
 * This approach (like gemini-cli and codex) passes the command directly to the shell
 * as an argument, avoiding issues with HEREDOC and special characters.
 *
 * On macOS, we prefer zsh because bash 3.2 (shipped with macOS due to GPL licensing)
 * has a bug with HEREDOC parsing when there's an odd number of apostrophes.
 * zsh handles this correctly and is the default shell on modern macOS.
 */
function getShellConfig(): {
  executable: string;
  args: (cmd: string) => string[];
} {
  if (cachedShellConfig) {
    return cachedShellConfig;
  }

  if (process.platform === "win32") {
    // Windows: use PowerShell
    cachedShellConfig = {
      executable: "powershell.exe",
      args: (cmd) => ["-NoProfile", "-Command", cmd],
    };
    return cachedShellConfig;
  }

  // On macOS, prefer zsh due to bash 3.2's HEREDOC bug with apostrophes
  if (process.platform === "darwin" && existsSync("/bin/zsh")) {
    cachedShellConfig = {
      executable: "/bin/zsh",
      args: (cmd) => ["-c", cmd],
    };
    return cachedShellConfig;
  }

  // Linux or macOS without zsh: use bash
  cachedShellConfig = {
    executable: "bash",
    args: (cmd) => ["-c", cmd],
  };
  return cachedShellConfig;
}

/**
 * Execute a command using spawn with explicit shell.
 * This avoids the double-shell parsing that exec() does.
 * Exported for use by bash mode in the CLI.
 */
export function spawnCommand(
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    signal?: AbortSignal;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const { executable, args } = getShellConfig();
    const childProcess = spawn(executable, args(command), {
      cwd: options.cwd,
      env: options.env,
      shell: false, // Don't use another shell layer
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      childProcess.kill("SIGTERM");
    }, options.timeout);

    const abortHandler = () => {
      childProcess.kill("SIGTERM");
    };
    if (options.signal) {
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    childProcess.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    childProcess.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    childProcess.on("error", (err) => {
      clearTimeout(timeoutId);
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      reject(err);
    });

    childProcess.on("close", (code) => {
      clearTimeout(timeoutId);
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (timedOut) {
        reject(
          Object.assign(new Error("Command timed out"), {
            killed: true,
            signal: "SIGTERM",
            stdout,
            stderr,
            code,
          }),
        );
        return;
      }

      if (options.signal?.aborted) {
        reject(
          Object.assign(new Error("The operation was aborted"), {
            name: "AbortError",
            code: "ABORT_ERR",
            stdout,
            stderr,
          }),
        );
        return;
      }

      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

interface BashArgs {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
  signal?: AbortSignal;
}

interface BashResult {
  content: Array<{
    type: string;
    text: string;
  }>;
  status: "success" | "error";
}

export async function bash(args: BashArgs): Promise<BashResult> {
  validateRequiredParams(args, ["command"], "Bash");
  const {
    command,
    timeout = 120000,
    description: _description,
    run_in_background = false,
    signal,
  } = args;
  const userCwd = process.env.USER_CWD || process.cwd();

  if (command === "/bg") {
    const processes = Array.from(backgroundProcesses.entries());
    if (processes.length === 0) {
      return {
        content: [{ type: "text", text: "(no content)" }],
        status: "success",
      };
    }
    let output = "";
    for (const [id, proc] of processes) {
      const runtime = proc.startTime
        ? `${Math.floor((Date.now() - proc.startTime.getTime()) / 1000)}s`
        : "unknown";
      output += `${id}: ${proc.command} (${proc.status}, runtime: ${runtime})\n`;
    }
    return {
      content: [{ type: "text", text: output.trim() }],
      status: "success",
    };
  }

  if (run_in_background) {
    const bashId = getNextBashId();
    const { executable, args } = getShellConfig();
    const childProcess = spawn(executable, args(command), {
      shell: false,
      cwd: userCwd,
      env: getShellEnv(),
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
      status: "success",
    };
  }

  const effectiveTimeout = Math.min(Math.max(timeout, 1), 600000);
  try {
    const { stdout, stderr, exitCode } = await spawnCommand(command, {
      cwd: userCwd,
      env: getShellEnv(),
      timeout: effectiveTimeout,
      signal,
    });

    let output = stdout;
    if (stderr) output = output ? `${output}\n${stderr}` : stderr;

    // Apply character limit to prevent excessive token usage
    const { content: truncatedOutput } = truncateByChars(
      output || "(Command completed with no output)",
      LIMITS.BASH_OUTPUT_CHARS,
      "Bash",
    );

    // Non-zero exit code is an error
    if (exitCode !== 0 && exitCode !== null) {
      return {
        content: [
          {
            type: "text",
            text: `Exit code: ${exitCode}\n${truncatedOutput}`,
          },
        ],
        status: "error",
      };
    }

    return {
      content: [{ type: "text", text: truncatedOutput }],
      status: "success",
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
      code?: string | number;
      name?: string;
    };
    const isAbort =
      signal?.aborted ||
      err.code === "ABORT_ERR" ||
      err.name === "AbortError" ||
      err.message === "The operation was aborted";

    let errorMessage = "";
    if (isAbort) {
      errorMessage = INTERRUPTED_BY_USER;
    } else {
      if (err.killed && err.signal === "SIGTERM")
        errorMessage = `Command timed out after ${effectiveTimeout}ms\n`;
      if (err.code && typeof err.code === "number")
        errorMessage += `Exit code: ${err.code}\n`;
      if (err.stderr) errorMessage += err.stderr;
      else if (err.message) errorMessage += err.message;
      if (err.stdout) errorMessage = `${err.stdout}\n${errorMessage}`;
    }

    // Apply character limit even to error messages
    const { content: truncatedError } = truncateByChars(
      errorMessage.trim() || "Command failed with unknown error",
      LIMITS.BASH_OUTPUT_CHARS,
      "Bash",
    );

    return {
      content: [{ type: "text", text: truncatedError }],
      status: "error",
    };
  }
}
