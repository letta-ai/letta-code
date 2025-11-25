/**
 * Gemini CLI replace tool - wrapper around Letta Code's Edit tool
 * Uses Gemini's exact schema and description
 */

import { edit } from "./Edit";

interface ReplaceGeminiArgs {
  file_path: string;
  old_string: string;
  new_string: string;
  expected_replacements?: number;
}

export async function replace(
  args: ReplaceGeminiArgs,
): Promise<{ message: string }> {
  // Adapt Gemini params to Letta Code's Edit tool
  // Gemini uses expected_replacements, Letta Code uses replace_all
  const lettaArgs = {
    file_path: args.file_path,
    old_string: args.old_string,
    new_string: args.new_string,
    replace_all: !!(
      args.expected_replacements && args.expected_replacements > 1
    ),
  };

  const result = await edit(lettaArgs);

  // Edit returns { message: string, replacements: number }
  return { message: result.message };
}
