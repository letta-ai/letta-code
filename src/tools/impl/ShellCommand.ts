import { ShellExecutionError, shell } from "./Shell.js";
import { buildShellLaunchers } from "./shellLaunchers.js";
import { validateRequiredParams } from "./validation.js";

interface ShellCommandArgs {
  command: string;
  workdir?: string;
  timeout_ms?: number;
  with_escalated_permissions?: boolean;
  justification?: string;
}

interface ShellCommandResult {
  output: string;
  stdout: string[];
  stderr: string[];
}

/**
 * Codex-style shell_command tool.
 * Runs a shell script string in the user's default shell.
 */
export async function shell_command(
  args: ShellCommandArgs,
): Promise<ShellCommandResult> {
  validateRequiredParams(args, ["command"], "shell_command");

  const {
    command,
    workdir,
    timeout_ms,
    with_escalated_permissions,
    justification,
  } = args;
  const launchers = buildShellLaunchers(command);
  if (launchers.length === 0) {
    throw new Error("Command must be a non-empty string");
  }

  const tried: string[] = [];
  let lastError: Error | null = null;

  for (const launcher of launchers) {
    try {
      return await shell({
        command: launcher,
        workdir,
        timeout_ms,
        with_escalated_permissions,
        justification,
      });
    } catch (error) {
      if (error instanceof ShellExecutionError && error.code === "ENOENT") {
        tried.push(launcher[0] || "");
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  const suffix = tried.filter(Boolean).join(", ");
  const reason = lastError?.message || "Shell unavailable";
  throw new Error(suffix ? `${reason} (tried: ${suffix})` : reason);
}
