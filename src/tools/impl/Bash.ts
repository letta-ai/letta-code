import { spawn } from "node:child_process";
import { INTERRUPTED_BY_USER } from "../../constants";
import {
  appendBackgroundProcessOutput,
  appendToOutputFile,
  assertBackgroundProcessCapacity,
  backgroundProcesses,
  createBackgroundOutputFile,
  getNextBashId,
  scheduleBackgroundProcessCleanup,
  unrefTimer,
} from "./process_manager.js";
import { getShellEnv } from "./shellEnv.js";
import { buildShellLaunchers } from "./shellLaunchers.js";
import { spawnWithLauncher } from "./shellRunner.js";
import { LIMITS, truncateByChars } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";
import { resolve } from "node:path";

/**
 * Check if a `git worktree add` command targets `.letta/worktrees/`.
 * Returns an error message if the path is invalid, or null if OK.
 */
function validateWorktreePath(command: string, cwd: string): string | null {
  // Match `git worktree add` with optional flags before the path
  const match = command.match(
    /\bgit\s+worktree\s+add\s+(?:-b\s+\S+\s+)?(\S+)/,
  );
  if (!match?.[1]) return null;

  const targetPath = match[1];
  const resolved = resolve(cwd, targetPath);
  const requiredPrefix = resolve(cwd, ".letta/worktrees");

  if (!resolved.startsWith(requiredPrefix)) {
    return (
      `Error: Worktrees must be created under .letta/worktrees/. ` +
      `Use: git worktree add -b <branch> .letta/worktrees/<name> main\n` +
      `Got: ${targetPath}`
    );
  }
  return null;
}

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
    return spawnWithLauncher([executable, "-c", command], {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeout,
      signal: options.signal,
      onOutput: options.onOutput,
    });
  }

  // On Windows, use fallback logic to handle PowerShell ENOENT errors (PR #482)
  if (cachedWorkingLauncher) {
    const [executable, ...launcherArgs] = cachedWorkingLauncher;
    if (executable) {
      const newLauncher = [executable, ...launcherArgs.slice(0, -1), command];
      try {
        const result = await spawnWithLauncher(newLauncher, {
          cwd: options.cwd,
          env: options.env,
          timeoutMs: options.timeout,
          signal: options.signal,
          onOutput: options.onOutput,
        });
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
      const result = await spawnWithLauncher(launcher, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeout,
        signal: options.signal,
        onOutput: options.onOutput,
      });
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

  // Block worktree creation outside .letta/worktrees/
  const worktreeError = validateWorktreePath(command, userCwd);
  if (worktreeError) {
    return {
      content: [{ type: "text", text: worktreeError }],
      status: "error",
    };
  }

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
    try {
      assertBackgroundProcessCapacity();
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        status: "error",
      };
    }

    const bashId = getNextBashId();
    const outputFile = createBackgroundOutputFile(bashId);
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
      outputFile,
      totalStdoutLines: 0,
      totalStderrLines: 0,
    });
    const bgProcess = backgroundProcesses.get(bashId);
    if (!bgProcess) {
      throw new Error("Failed to track background process state");
    }
    childProcess.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      appendBackgroundProcessOutput(bgProcess, "stdout", text);
      // Also write to output file
      appendToOutputFile(outputFile, text);
    });
    childProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      appendBackgroundProcessOutput(bgProcess, "stderr", text);
      // Also write to output file (prefixed with [stderr])
      appendToOutputFile(outputFile, `[stderr] ${text}`);
    });
    childProcess.on("exit", (code: number | null) => {
      bgProcess.status = code === 0 ? "completed" : "failed";
      bgProcess.exitCode = code;
      appendToOutputFile(outputFile, `\n[exit code: ${code}]\n`);
      scheduleBackgroundProcessCleanup(bashId);
    });
    childProcess.on("error", (err: Error) => {
      bgProcess.status = "failed";
      appendBackgroundProcessOutput(bgProcess, "stderr", err.message);
      appendToOutputFile(outputFile, `\n[error] ${err.message}\n`);
      scheduleBackgroundProcessCleanup(bashId);
    });
    if (timeout && timeout > 0) {
      const timeoutHandle = setTimeout(() => {
        if (bgProcess.status === "running") {
          childProcess.kill("SIGTERM");
          bgProcess.status = "failed";
          appendBackgroundProcessOutput(
            bgProcess,
            "stderr",
            `Command timed out after ${timeout}ms`,
          );
          appendToOutputFile(outputFile, `\n[timeout after ${timeout}ms]\n`);
          scheduleBackgroundProcessCleanup(bashId);
        }
      }, timeout);
      unrefTimer(timeoutHandle);
    }
    return {
      content: [
        {
          type: "text",
          text: `Command running in background with ID: ${bashId}\nOutput file: ${outputFile}`,
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
