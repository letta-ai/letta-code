import { bash } from "./Bash.js";
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

  const { command, workdir, timeout_ms, justification: description } = args;

  // Reuse Bash implementation for execution, but honor the requested workdir
  const previousUserCwd = process.env.USER_CWD;
  if (workdir) {
    process.env.USER_CWD = workdir;
  }

  try {
    const result = await bash({
      command,
      timeout: timeout_ms ?? 120000,
      description,
      run_in_background: false,
    });

    const text = (result.content ?? [])
      .map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");

    const stdout = text ? text.split("\n") : [];
    const stderr =
      "isError" in result && (result as { isError?: boolean }).isError
        ? ["Command reported an error. See output for details."]
        : [];

    return {
      output: text,
      stdout,
      stderr,
    };
  } finally {
    if (workdir) {
      if (previousUserCwd === undefined) {
        delete process.env.USER_CWD;
      } else {
        process.env.USER_CWD = previousUserCwd;
      }
    }
  }
}












