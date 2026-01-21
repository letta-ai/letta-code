// src/hooks/executor.ts
// Execute hook commands

import { spawn } from "node:child_process";
import type {
  HookCommand,
  HookEventResult,
  HookExecutionResult,
  HookInput,
  HookOutput,
  PermissionDecision,
  PermissionRequestHookOutput,
} from "./types";

/**
 * Execute a single hook command with the given input.
 *
 * @param command - The hook command to execute
 * @param input - JSON input to pass via stdin
 * @returns Execution result including exit code, output, and timing
 */
export async function executeHookCommand(
  command: HookCommand,
  input: HookInput,
): Promise<HookExecutionResult> {
  const startTime = performance.now();
  const timeoutMs = (command.timeout ?? 60) * 1000;

  return new Promise((resolve) => {
    const proc = spawn(command.command, [], {
      shell: true,
      cwd: process.cwd(),
      env: {
        ...process.env,
        LETTA_PROJECT_DIR: process.cwd(),
      },
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Send input via stdin
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    // Handle timeout
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutMs);

    proc.on("close", (exitCode) => {
      clearTimeout(timeoutHandle);
      const durationMs = performance.now() - startTime;

      // Try to parse JSON output if exit code is 0
      let output: HookOutput | undefined;
      if (exitCode === 0 && stdout.trim()) {
        try {
          output = JSON.parse(stdout.trim()) as HookOutput;
        } catch {
          // Not valid JSON, that's okay - stdout will be treated as plain text
        }
      }

      resolve({
        command,
        exitCode: exitCode ?? -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        output,
        timedOut,
        durationMs,
      });
    });

    proc.on("error", (error) => {
      clearTimeout(timeoutHandle);
      const durationMs = performance.now() - startTime;

      resolve({
        command,
        exitCode: -1,
        stdout: "",
        stderr: error.message,
        timedOut: false,
        durationMs,
      });
    });
  });
}

/**
 * Execute multiple hook commands in parallel.
 *
 * @param commands - Array of hook commands to execute
 * @param input - JSON input to pass to all hooks
 * @returns Array of execution results
 */
export async function executeHookCommands(
  commands: HookCommand[],
  input: HookInput,
): Promise<HookExecutionResult[]> {
  if (commands.length === 0) {
    return [];
  }

  // Execute all commands in parallel
  return Promise.all(
    commands.map((command) => executeHookCommand(command, input)),
  );
}

/**
 * Aggregate results from multiple hook executions into a single result.
 *
 * Processing rules:
 * - Exit code 2 from any hook blocks the action (stderr used as reason)
 * - JSON output with decision: "block" or continue: false also blocks
 * - permissionDecision from any hook is used (last one wins)
 * - updatedInput from any hook is used (last one wins, merged)
 * - additionalContext from all hooks is concatenated
 * - systemMessage from all hooks is collected
 *
 * @param results - Array of individual hook execution results
 * @returns Aggregated event result
 */
export function aggregateHookResults(
  results: HookExecutionResult[],
): HookEventResult {
  const eventResult: HookEventResult = {
    results,
    blocked: false,
    shouldContinue: true,
    systemMessages: [],
  };

  // Collect additional context from all hooks
  const additionalContextParts: string[] = [];

  for (const result of results) {
    // Check for blocking exit code (2)
    if (result.exitCode === 2) {
      eventResult.blocked = true;
      eventResult.blockReason =
        result.stderr || `Hook "${result.command.command}" blocked the action`;
      // Note: we don't break here - we still want to process other results
      // for context aggregation, but the blocked status is set
    }

    // Check for timeout
    if (result.timedOut) {
      eventResult.systemMessages.push(
        `Hook "${result.command.command}" timed out after ${result.command.timeout || 60}s`,
      );
    }

    // Process JSON output (only if exit code is 0)
    if (result.output && result.exitCode === 0) {
      const output = result.output;

      // Check continue field
      if (output.continue === false) {
        eventResult.shouldContinue = false;
        eventResult.stopReason =
          output.stopReason || "Hook requested to stop processing";
      }

      // Check decision field (legacy support for PostToolUse/Stop/SubagentStop)
      if (output.decision === "block") {
        eventResult.blocked = true;
        eventResult.blockReason = output.reason || "Hook blocked the action";
      }

      // Collect system messages
      if (output.systemMessage) {
        eventResult.systemMessages.push(output.systemMessage);
      }

      // Process hook-specific output
      if (output.hookSpecificOutput) {
        const specific = output.hookSpecificOutput;

        // PreToolUse specific
        if (specific.hookEventName === "PreToolUse") {
          if (specific.permissionDecision) {
            eventResult.permissionDecision =
              specific.permissionDecision as PermissionDecision;
            eventResult.permissionDecisionReason =
              specific.permissionDecisionReason;
          }
          if (specific.updatedInput) {
            eventResult.updatedInput = {
              ...eventResult.updatedInput,
              ...specific.updatedInput,
            };
          }
          if (specific.additionalContext) {
            additionalContextParts.push(specific.additionalContext);
          }
        }

        // PermissionRequest specific
        if (specific.hookEventName === "PermissionRequest") {
          eventResult.permissionRequestDecision = (
            specific as PermissionRequestHookOutput
          ).decision;
        }

        // PostToolUse specific
        if (specific.hookEventName === "PostToolUse") {
          if (specific.additionalContext) {
            additionalContextParts.push(specific.additionalContext);
          }
        }

        // UserPromptSubmit specific
        if (specific.hookEventName === "UserPromptSubmit") {
          if (specific.additionalContext) {
            additionalContextParts.push(specific.additionalContext);
          }
        }

        // SessionStart specific
        if (specific.hookEventName === "SessionStart") {
          if (specific.additionalContext) {
            additionalContextParts.push(specific.additionalContext);
          }
        }

        // Setup specific
        if (specific.hookEventName === "Setup") {
          if (specific.additionalContext) {
            additionalContextParts.push(specific.additionalContext);
          }
        }
      }
    }

    // For UserPromptSubmit and SessionStart, plain text stdout (non-JSON) is also context
    if (
      result.exitCode === 0 &&
      !result.output &&
      result.stdout &&
      (result.command.command.includes("UserPromptSubmit") ||
        result.command.command.includes("SessionStart"))
    ) {
      additionalContextParts.push(result.stdout);
    }
  }

  // Combine additional context
  if (additionalContextParts.length > 0) {
    eventResult.additionalContext = additionalContextParts.join("\n\n");
  }

  return eventResult;
}

/**
 * Execute hooks for an event and return aggregated results.
 *
 * @param commands - Array of hook commands to execute
 * @param input - JSON input for the hooks
 * @returns Aggregated event result
 */
export async function executeHooks(
  commands: HookCommand[],
  input: HookInput,
): Promise<HookEventResult> {
  const results = await executeHookCommands(commands, input);
  return aggregateHookResults(results);
}
