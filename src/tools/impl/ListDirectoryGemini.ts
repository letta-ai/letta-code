/**
 * Gemini CLI list_directory tool - wrapper around Letta Code's LS tool
 * Uses Gemini's exact schema and description
 */

import { ls } from "./LS";

interface ListDirectoryGeminiArgs {
  dir_path: string;
  ignore?: string[];
  file_filtering_options?: {
    respect_git_ignore?: boolean;
    respect_gemini_ignore?: boolean;
  };
}

export async function list_directory(
  args: ListDirectoryGeminiArgs,
): Promise<{ message: string }> {
  // Adapt Gemini params to Letta Code's LS tool
  const lettaArgs = {
    path: args.dir_path,
    ignore: args.ignore,
  };

  const result = await ls(lettaArgs);

  // LS returns { content: Array<{ type: string, text: string }> }
  // Convert to string message
  const message = result.content.map((item) => item.text).join("\n");
  return { message };
}
