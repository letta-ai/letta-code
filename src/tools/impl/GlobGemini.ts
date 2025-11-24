/**
 * Gemini CLI glob tool - wrapper around Letta Code's Glob tool
 * Uses Gemini's exact schema and description
 */

import { glob as lettaGlob } from "./Glob";

interface GlobGeminiArgs {
  pattern: string;
  dir_path?: string;
  case_sensitive?: boolean;
  respect_git_ignore?: boolean;
  respect_gemini_ignore?: boolean;
}

export async function glob_gemini(
  args: GlobGeminiArgs,
): Promise<{ message: string }> {
  // Adapt Gemini params to Letta Code's Glob tool
  const lettaArgs = {
    pattern: args.pattern,
    path: args.dir_path,
  };

  const result = await lettaGlob(lettaArgs);

  // Glob returns { files: string[], truncated?, totalFiles? }
  const message = result.files.join("\n");
  return { message };
}
