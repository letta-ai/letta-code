// src/hooks/executor.ts
// Executes hook commands with JSON input via stdin

import { spawn } from "node:child_process";
import {
  HookExitCode,
  type HookCommand,
  type HookExecutionResult,
  type HookInput,
  type HookResult,
} from "./types";

/** Default timeout for hook execution (60 seconds) */
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Execute a single hook command with JSON input via stdin
 */
export async function executeHookCommand(
  hook: HookCommand,
  input: HookInput,
  workingDirectory: string = process.cwd(),
): Promise<HookResult> {
  const startTime = Date.now();
  const timeout = hook.timeout ?? DEFAULT_TIMEOUT_MS;
  const inputJson = JSON.stringify(input);

  return new Promise<HookResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let resolved = false;

    const safeResolve = (result: HookResult) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    try {
      // Spawn shell process to run the hook command
      const child = spawn("sh", ["-c", hook.command], {
        cwd: workingDirectory,
        env: {
          ...process.env,
          // Add hook-specific environment variables
          LETTA_HOOK_EVENT: input.event_type,
          LETTA_WORKING_DIR: workingDirectory,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

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
      child.on("close", (code) => {
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

      // Handle spawn error
      child.on("error", (error) => {
        clearTimeout(timeoutId);
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
    } catch (error) {
      const durationMs = Date.now() - startTime;
      safeResolve({
        exitCode: HookExitCode.ERROR,
        stdout: "",
        stderr: "",
        timedOut: false,
        durationMs,
        error: `Failed to spawn hook process: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
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
