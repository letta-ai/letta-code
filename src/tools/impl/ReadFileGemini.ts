/**
 * Gemini CLI read_file tool - wrapper around Letta Code's Read tool
 * Uses Gemini's exact schema and description
 */

import type { TextContent } from "@letta-ai/letta-client/resources/agents/messages";
import { read, type ToolReturnContent } from "./Read";

interface ReadFileGeminiArgs {
  file_path: string;
  offset?: number;
  limit?: number;
}

/**
 * Extract text from tool return content (for Gemini wrapper)
 */
function extractText(content: ToolReturnContent): string {
  if (typeof content === "string") {
    return content;
  }
  // Extract text from multimodal content (Gemini doesn't support images via this tool)
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
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

  // Read returns { content: ToolReturnContent } - extract text for Gemini
  return { message: extractText(result.content) };
}
