import { shell } from "./Shell.js";
import { buildShellLaunchers } from "./shellLaunchers.js";
import { ShellExecutionError } from "./shellRunner.js";
import { validateRequiredParams } from "./validation.js";

interface ShellCommandArgs {
  command: string;
  workdir?: string;
  login?: boolean;
  timeout_ms?: number;
  sandbox_permissions?: "use_default" | "require_escalated";
  justification?: string;
  prefix_rule?: string[];
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
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
    login = true,
    timeout_ms,
    justification,
    signal,
    onOutput,
  } = args;
  const launchers = buildShellLaunchers(command, { login });
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
        justification,
        signal,
        onOutput,
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
