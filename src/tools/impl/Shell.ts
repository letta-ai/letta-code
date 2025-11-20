import { bash } from "./Bash.js";
import { validateRequiredParams } from "./validation.js";

interface ShellArgs {
  command: string[];
  workdir?: string;
  timeout_ms?: number;
  with_escalated_permissions?: boolean;
  justification?: string;
}

interface ShellResult {
  output: string;
  stdout: string[];
  stderr: string[];
}

/**
 * Codex-style shell tool.
 * Runs an array of shell arguments, typically ["bash", "-lc", "..."].
 */
export async function shell(args: ShellArgs): Promise<ShellResult> {
  validateRequiredParams(args, ["command"], "shell");

  const { command, workdir, timeout_ms, justification: description } = args;
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error("command must be a non-empty array of strings");
  }

  const commandString = command.join(" ");

  const previousUserCwd = process.env.USER_CWD;
  if (workdir) {
    process.env.USER_CWD = workdir;
  }

  try {
    const result = await bash({
      command: commandString,
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









