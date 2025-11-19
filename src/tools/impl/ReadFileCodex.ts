import { read } from "./Read.js";
import { validateRequiredParams } from "./validation.js";

interface IndentationOptions {
  anchor_line?: number;
  max_levels?: number;
  include_siblings?: boolean;
  include_header?: boolean;
  max_lines?: number;
}

interface ReadFileCodexArgs {
  file_path: string;
  offset?: number;
  limit?: number;
  mode?: "slice" | "indentation" | string;
  indentation?: IndentationOptions;
}

interface ReadFileCodexResult {
  content: string;
}

/**
 * Codex-style read_file tool.
 * Currently supports slice-style reading; indentation mode is ignored but accepted.
 */
export async function read_file(
  args: ReadFileCodexArgs,
): Promise<ReadFileCodexResult> {
  validateRequiredParams(args, ["file_path"], "read_file");

  const { file_path, offset, limit } = args;

  const result = await read({
    file_path,
    offset,
    limit,
  });

  return { content: result.content };
}



