/**
 * Gemini CLI write_file tool - wrapper around Letta Code's Write tool
 * Uses Gemini's exact schema and description
 */

import { write } from "./Write";

interface WriteFileGeminiArgs {
  file_path: string;
  content: string;
}

export async function write_file_gemini(
  args: WriteFileGeminiArgs,
): Promise<{ message: string }> {
  // Direct mapping - parameters match exactly
  const result = await write(args);

  // Write returns { message: string }
  return result;
}
