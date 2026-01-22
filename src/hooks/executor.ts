// src/hooks/executor.ts
// Executes hook commands with JSON input via stdin
// Cross-platform: uses platform-appropriate shell (PowerShell on Windows, sh/bash/zsh on Unix)

import { spawn, type ChildProcess } from "node:child_process";
import { buildShellLaunchers } from "../tools/impl/shellLaunchers";
import {
  type HookCommand,
  type HookExecutionResult,
  HookExitCode,
  type HookInput,
  type HookResult,
} from "./types";

/** Default timeout for hook execution (60 seconds) */
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Try to spawn a hook command with a specific launcher
 * Returns the child process or throws an error
 */
function trySpawnWithLauncher(
  launcher: string[],
  workingDirectory: string,
  input: HookInput,
): ChildProcess {
  const [executable, ...args] = launcher;
  if (!executable) {
    throw new Error("Empty launcher");
  }

  return spawn(executable, args, {
    cwd: workingDirectory,
    env: {
      ...process.env,
      // Add hook-specific environment variables
      LETTA_HOOK_EVENT: input.event_type,
      LETTA_WORKING_DIR: workingDirectory,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Execute a single hook command with JSON input via stdin
 * Uses cross-platform shell launchers with fallback support
 */
export async function executeHookCommand(
  hook: HookCommand,
  input: HookInput,
  workingDirectory: string = process.cwd(),
): Promise<HookResult> {
  const startTime = Date.now();
  const timeout = hook.timeout ?? DEFAULT_TIMEOUT_MS;
  const inputJson = JSON.stringify(input);

  // Get platform-appropriate shell launchers
  const launchers = buildShellLaunchers(hook.command);
  if (launchers.length === 0) {
    return {
      exitCode: HookExitCode.ERROR,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: Date.now() - startTime,
      error: "No shell launchers available for this platform",
    };
  }

  // Try each launcher until one works
  let lastError: Error | null = null;

  for (const launcher of launchers) {
    try {
      const result = await executeWithLauncher(
        launcher,
        inputJson,
        workingDirectory,
        input,
        timeout,
        hook.command,
        startTime,
      );
      return result;
    } catch (error) {
      // If ENOENT (executable not found), try the next launcher
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        lastError = error;
        continue;
      }
      // For other errors, fail immediately
      throw error;
    }
  }

  // All launchers failed
  return {
    exitCode: HookExitCode.ERROR,
    stdout: "",
    stderr: "",
    timedOut: false,
    durationMs: Date.now() - startTime,
    error: `Failed to execute hook: ${lastError?.message || "No suitable shell found"}`,
  };
}

/**
 * Execute a hook with a specific launcher
 */
function executeWithLauncher(
  launcher: string[],
  inputJson: string,
  workingDirectory: string,
  input: HookInput,
  timeout: number,
  command: string,
  startTime: number,
): Promise<HookResult> {
  return new Promise<HookResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let resolved = false;

    const safeResolve = (result: HookResult) => {
      if (!resolved) {
        resolved = true;
        // Log hook completion
        const exitLabel =
          result.exitCode === HookExitCode.ALLOW
            ? "\x1b[32m✓ allowed\x1b[0m"
            : result.exitCode === HookExitCode.BLOCK
              ? "\x1b[31m✗ blocked\x1b[0m"
              : "\x1b[33m⚠ error\x1b[0m";
        console.log(
          `\x1b[90m[hook] ${exitLabel} (${result.durationMs}ms)${result.stdout ? ` stdout: ${result.stdout.slice(0, 100)}` : ""}${result.stderr ? ` stderr: ${result.stderr.slice(0, 100)}` : ""}\x1b[0m`,
        );
        resolve(result);
      }
    };

    // Log hook start
    console.log(`\x1b[90m[hook] Running: ${command}\x1b[0m`);

    let child: ChildProcess;
    try {
      child = trySpawnWithLauncher(launcher, workingDirectory, input);
    } catch (error) {
      reject(error);
      return;
    }

    // Set up timeout
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Give process time to clean up, then force kill
      setTimeout(() => {
        if (!resolved) {
          child.kill("SIGKILL");
        }
      }, 1000);
    }, timeout);

    // Write JSON input to stdin
    if (child.stdin) {
      // Handle stdin errors (e.g., EPIPE if process exits before reading)
      child.stdin.on("error", () => {
        // Silently ignore - process may have exited before reading stdin
      });
      child.stdin.write(inputJson);
      child.stdin.end();
    }

    // Collect stdout
    if (child.stdout) {
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
    }

    // Collect stderr
    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
    }

    // Handle process exit
    child.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;

      // Map exit code to our enum
      let exitCode: HookExitCode;
      if (timedOut) {
        exitCode = HookExitCode.ERROR;
      } else if (code === null) {
        exitCode = HookExitCode.ERROR;
      } else if (code === 0) {
        exitCode = HookExitCode.ALLOW;
      } else if (code === 2) {
        exitCode = HookExitCode.BLOCK;
      } else {
        exitCode = HookExitCode.ERROR;
      }

      safeResolve({
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        durationMs,
        ...(timedOut && { error: `Hook timed out after ${timeout}ms` }),
      });
    });

    // Handle spawn error - reject to try next launcher
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeoutId);

      // For ENOENT, reject so we can try the next launcher
      if (error.code === "ENOENT") {
        reject(error);
        return;
      }

      // For other errors, resolve with error result
      const durationMs = Date.now() - startTime;
      safeResolve({
        exitCode: HookExitCode.ERROR,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut: false,
        durationMs,
        error: `Failed to execute hook: ${error.message}`,
      });
    });
  });
}

/**
 * Execute multiple hooks sequentially and aggregate results
 * Stops early if any hook returns BLOCK (exit code 2)
 */
export async function executeHooks(
  hooks: HookCommand[],
  input: HookInput,
  workingDirectory: string = process.cwd(),
): Promise<HookExecutionResult> {
  const results: HookResult[] = [];
  const feedback: string[] = [];
  let blocked = false;
  let errored = false;

  for (const hook of hooks) {
    const result = await executeHookCommand(hook, input, workingDirectory);
    results.push(result);

    // Collect feedback from stdout when hook blocks
    if (result.exitCode === HookExitCode.BLOCK) {
      blocked = true;
      if (result.stdout) {
        feedback.push(result.stdout);
      }
      // Stop processing more hooks after a block
      break;
    }

    // Track errors but continue processing
    if (result.exitCode === HookExitCode.ERROR) {
      errored = true;
      if (result.stderr) {
        feedback.push(`Hook error: ${result.stderr}`);
      } else if (result.error) {
        feedback.push(`Hook error: ${result.error}`);
      }
    }
  }

  return {
    blocked,
    errored,
    feedback,
    results,
  };
}

/**
 * Execute hooks in parallel (for non-blocking hooks like PostToolUse)
 */
export async function executeHooksParallel(
  hooks: HookCommand[],
  input: HookInput,
  workingDirectory: string = process.cwd(),
): Promise<HookExecutionResult> {
  const results = await Promise.all(
    hooks.map((hook) => executeHookCommand(hook, input, workingDirectory)),
  );

  const feedback: string[] = [];
  let blocked = false;
  let errored = false;

  for (const result of results) {
    if (result.exitCode === HookExitCode.BLOCK) {
      blocked = true;
      if (result.stdout) {
        feedback.push(result.stdout);
      }
    }
    if (result.exitCode === HookExitCode.ERROR) {
      errored = true;
      if (result.stderr) {
        feedback.push(`Hook error: ${result.stderr}`);
      } else if (result.error) {
        feedback.push(`Hook error: ${result.error}`);
      }
    }
  }

  return {
    blocked,
    errored,
    feedback,
    results,
  };
}
