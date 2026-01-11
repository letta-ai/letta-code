import { spawn } from "node:child_process";
import { INTERRUPTED_BY_USER } from "../../constants";
import { backgroundProcesses, getNextBashId } from "./process_manager.js";
import { getShellEnv } from "./shellEnv.js";
import { buildShellLaunchers } from "./shellLaunchers.js";
import { LIMITS, truncateByChars } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";

// Cache the working shell launcher after first successful spawn
let cachedWorkingLauncher: string[] | null = null;

/**
 * Get the first working shell launcher for background processes.
 * Uses cached launcher if available, otherwise returns first launcher from buildShellLaunchers.
 * For background processes, we can't easily do async fallback, so we rely on cached launcher
 * from previous foreground commands or the default launcher order.
 */
function getBackgroundLauncher(command: string): string[] {
  if (cachedWorkingLauncher) {
    const [executable, ...launcherArgs] = cachedWorkingLauncher;
    if (executable) {
      return [executable, ...launcherArgs.slice(0, -1), command];
    }
  }
  const launchers = buildShellLaunchers(command);
  return launchers[0] || [];
}

/**
 * Spawn a command with a specific launcher.
 * Returns a promise that resolves with the output or rejects with an error.
 */
function spawnWithLauncher(
  launcher: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    signal?: AbortSignal;
    onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const [executable, ...args] = launcher;
    if (!executable) {
      reject(new Error("Empty launcher"));
      return;
    }

    const childProcess = spawn(executable, args, {
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
      options.onOutput?.(chunk.toString("utf8"), "stdout");
    });

    childProcess.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      options.onOutput?.(chunk.toString("utf8"), "stderr");
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

/**
 * Execute a command using spawn with explicit shell.
 * This avoids the double-shell parsing that exec() does.
 * Uses buildShellLaunchers() to try multiple shells with ENOENT fallback.
 * Exported for use by bash mode in the CLI.
 */
export async function spawnCommand(
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    signal?: AbortSignal;
    onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  // On Unix (Linux/macOS), use simple bash -c approach (original behavior)
  // This avoids the complexity of fallback logic which caused issues on ARM64 CI
  if (process.platform !== "win32") {
    // On macOS, prefer zsh due to bash 3.2's HEREDOC bug with apostrophes
    const executable = process.platform === "darwin" ? "/bin/zsh" : "bash";
    return spawnWithLauncher([executable, "-c", command], options);
  }

  // On Windows, use fallback logic to handle PowerShell ENOENT errors (PR #482)
  if (cachedWorkingLauncher) {
    const [executable, ...launcherArgs] = cachedWorkingLauncher;
    if (executable) {
      const newLauncher = [executable, ...launcherArgs.slice(0, -1), command];
      try {
        const result = await spawnWithLauncher(newLauncher, options);
        return result;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
        cachedWorkingLauncher = null;
      }
    }
  }

  const launchers = buildShellLaunchers(command);
  if (launchers.length === 0) {
    throw new Error("No shell launchers available");
  }

  const tried: string[] = [];
  let lastError: Error | null = null;

  for (const launcher of launchers) {
    try {
      const result = await spawnWithLauncher(launcher, options);
      cachedWorkingLauncher = launcher;
      return result;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        tried.push(launcher[0] || "unknown");
        lastError = err;
        continue;
      }
      throw error;
    }
  }

  const suffix = tried.filter(Boolean).join(", ");
  const reason = lastError?.message || "Shell unavailable";
  throw new Error(suffix ? `${reason} (tried: ${suffix})` : reason);
}

interface BashArgs {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
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
    onOutput,
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
    const launcher = getBackgroundLauncher(command);
    const [executable, ...launcherArgs] = launcher;
    if (!executable) {
      return {
        content: [{ type: "text", text: "No shell available" }],
        status: "error",
      };
    }
    const childProcess = spawn(executable, launcherArgs, {
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
      onOutput,
    });

    let output = stdout;
    if (stderr) output = output ? `${output}\n${stderr}` : stderr;

    // Apply character limit to prevent excessive token usage
    const { content: truncatedOutput } = truncateByChars(
      output || "(Command completed with no output)",
      LIMITS.BASH_OUTPUT_CHARS,
      "Bash",
      { workingDirectory: userCwd, toolName: "Bash" },
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
      { workingDirectory: userCwd, toolName: "Bash" },
    );

    return {
      content: [{ type: "text", text: truncatedError }],
      status: "error",
    };
  }
}
