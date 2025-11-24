/**
 * Gemini CLI read_file tool - wrapper around Letta Code's Read tool
 * Uses Gemini's exact schema and description
 */

import { read } from "./Read";

interface ReadFileGeminiArgs {
  file_path: string;
  offset?: number;
  limit?: number;
}

export async function read_file_gemini(
  args: ReadFileGeminiArgs,
): Promise<{ message: string }> {
  // Adapt Gemini params to Letta Code's Read tool
  // Gemini uses 0-based offset, Letta Code uses 1-based
  const lettaArgs = {
    file_path: args.file_path,
    offset: args.offset !== undefined ? args.offset + 1 : undefined,
    limit: args.limit,
  };

  const result = await read(lettaArgs);

  // Read returns { content: string }
  return { message: result.content };
}
