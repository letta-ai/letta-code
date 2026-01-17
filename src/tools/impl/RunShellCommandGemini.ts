/**
 * Gemini CLI run_shell_command tool - wrapper around Letta Code's Bash tool
 * Uses Gemini's exact schema and description
 */

import { shell_command } from "./ShellCommand";

interface RunShellCommandGeminiArgs {
  command: string;
  description?: string;
  dir_path?: string;
  timeout_ms?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}

export async function run_shell_command(
  args: RunShellCommandGeminiArgs,
): Promise<{ message: string }> {
  const result = await shell_command({
    command: args.command,
    workdir: args.dir_path,
    timeout_ms: args.timeout_ms,
    signal: args.signal,
    onOutput: args.onOutput,
  });

  const message = result.output.trim() || "(Command completed with no output)";
  return { message };
}
