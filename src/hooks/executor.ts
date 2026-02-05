// src/hooks/executor.ts
// Executes hook commands with JSON input via stdin
// Cross-platform: uses platform-appropriate shell (PowerShell on Windows, sh/bash/zsh on Unix)

import { type ChildProcess, spawn } from "node:child_process";
import { buildShellLaunchers } from "../tools/impl/shellLaunchers";
import { executePromptHook } from "./prompt-executor";
import {
  type CommandHookConfig,
  type HookCommand,
  type HookExecutionResult,
  HookExitCode,
  type HookInput,
  type HookResult,
  isCommandHook,
  isPromptHook,
} from "./types";

/** Default timeout for hook execution (60 seconds) */
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Get a display identifier for a hook (for logging and feedback)
 */
function getHookIdentifier(hook: HookCommand): string {
  if (isCommandHook(hook)) {
    return hook.command;
  }
  if (isPromptHook(hook)) {
    // Use first 50 chars of prompt as identifier
    return `prompt:${hook.prompt.slice(0, 50)}${hook.prompt.length > 50 ? "..." : ""}`;
  }
  return "unknown";
}

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

  // Extract agent_id if present (available on many hook input types)
  const agentId = "agent_id" in input ? input.agent_id : undefined;

  // Build environment: start with parent env but exclude LETTA_AGENT_ID to prevent inheritance
  // We only want to pass the agent ID that's explicitly provided in the hook input
  const { LETTA_AGENT_ID: _, ...parentEnv } = process.env;

  return spawn(executable, args, {
    cwd: workingDirectory,
    env: {
      ...parentEnv,
      // Add hook-specific environment variables
      LETTA_HOOK_EVENT: input.event_type,
      LETTA_WORKING_DIR: workingDirectory,
      ...(agentId && { LETTA_AGENT_ID: agentId }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Execute a single hook with JSON input
 * Dispatches to appropriate executor based on hook type:
 * - "command": executes shell command with JSON via stdin
 * - "prompt": sends to LLM for evaluation
 */
export async function executeHookCommand(
  hook: HookCommand,
  input: HookInput,
  workingDirectory: string = process.cwd(),
): Promise<HookResult> {
  // Dispatch based on hook type
  if (isPromptHook(hook)) {
    return executePromptHook(hook, input, workingDirectory);
  }

  // Default to command hook execution
  if (isCommandHook(hook)) {
    return executeCommandHook(hook, input, workingDirectory);
  }

  // Unknown hook type
  return {
    exitCode: HookExitCode.ERROR,
    stdout: "",
    stderr: "",
    timedOut: false,
    durationMs: 0,
    error: `Unknown hook type: ${(hook as HookCommand).type}`,
  };
}

/**
 * Execute a command hook with JSON input via stdin
 * Uses cross-platform shell launchers with fallback support
 */
export async function executeCommandHook(
  hook: CommandHookConfig,
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
        // Log hook completion with command for context
        // Show exit code with color: green for 0, red for 2, yellow for errors
        const exitCode =
          result.exitCode === HookExitCode.ALLOW
            ? 0
            : result.exitCode === HookExitCode.BLOCK
              ? 2
              : 1;
        const exitColor =
          result.exitCode === HookExitCode.ALLOW
            ? "\x1b[32m"
            : result.exitCode === HookExitCode.BLOCK
              ? "\x1b[31m"
              : "\x1b[33m";
        const exitLabel = result.timedOut
          ? `${exitColor}timeout\x1b[0m`
          : `${exitColor}exit ${exitCode}\x1b[0m`;
        console.log(`\x1b[90m[hook:${input.event_type}] ${command}\x1b[0m`);
        console.log(
          `\x1b[90m  \u23BF ${exitLabel} (${result.durationMs}ms)\x1b[0m`,
        );
        if (result.stdout) {
          console.log(`\x1b[90m  \u23BF (stdout)\x1b[0m`);
          const indented = result.stdout
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n");
          console.log(`\x1b[90m${indented}\x1b[0m`);
        }
        if (result.stderr) {
          console.log(`\x1b[90m  \u23BF (stderr)\x1b[0m`);
          const indented = result.stderr
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n");
          console.log(`\x1b[90m${indented}\x1b[0m`);
        }
        resolve(result);
      }
    };

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

    // Collect feedback from stdout when hook succeeds (exit 0)
    // Only for UserPromptSubmit and SessionStart hooks
    if (result.exitCode === HookExitCode.ALLOW) {
      if (
        result.stdout?.trim() &&
        (input.event_type === "UserPromptSubmit" ||
          input.event_type === "SessionStart")
      ) {
        feedback.push(result.stdout.trim());
      }
      continue;
    }

    // Collect feedback from stderr when hook blocks
    // Format: [hook identifier]: {stderr} per spec
    if (result.exitCode === HookExitCode.BLOCK) {
      blocked = true;
      if (result.stderr) {
        feedback.push(`[${getHookIdentifier(hook)}]: ${result.stderr}`);
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

  // Zip hooks with results to access command for formatting
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const hook = hooks[i];
    if (!result || !hook) continue;

    // For exit 0, try to parse JSON for additionalContext
    if (result.exitCode === HookExitCode.ALLOW && result.stdout?.trim()) {
      try {
        const json = JSON.parse(result.stdout.trim());
        const additionalContext =
          json?.hookSpecificOutput?.additionalContext ||
          json?.additionalContext;
        if (additionalContext) {
          feedback.push(additionalContext);
        }
      } catch {
        // Not JSON, ignore
      }
    }

    // Format: [command]: {stderr} per spec
    if (result.exitCode === HookExitCode.BLOCK) {
      blocked = true;
      if (result.stderr) {
        feedback.push(`[${getHookIdentifier(hook)}]: ${result.stderr}`);
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
