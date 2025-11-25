/**
 * Gemini CLI run_shell_command tool - wrapper around Letta Code's Bash tool
 * Uses Gemini's exact schema and description
 */

import { bash } from "./Bash";

interface RunShellCommandGeminiArgs {
  command: string;
  description?: string;
  dir_path?: string;
}

export async function run_shell_command(
  args: RunShellCommandGeminiArgs,
): Promise<{ message: string }> {
  // Adapt Gemini params to Letta Code's Bash tool
  const lettaArgs = {
    command: args.command,
    description: args.description,
  };

  const result = await bash(lettaArgs);

  // Bash returns { content: Array<{ type: string, text: string }>, status: string }
  const message = result.content.map((item) => item.text).join("\n");
  return { message };
}
