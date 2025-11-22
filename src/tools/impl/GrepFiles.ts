import { type GrepArgs, grep } from "./Grep.js";
import { validateRequiredParams } from "./validation.js";

interface GrepFilesArgs {
  pattern: string;
  include?: string;
  path?: string;
  limit?: number;
}

type GrepFilesResult = Awaited<ReturnType<typeof grep>>;

/**
 * Codex-style grep_files tool.
 * Uses the existing Grep implementation and returns a list of files with matches.
 */
export async function grep_files(
  args: GrepFilesArgs,
): Promise<GrepFilesResult> {
  validateRequiredParams(args, ["pattern"], "grep_files");

  const { pattern, include, path } = args;

  const grepArgs: GrepArgs = {
    pattern,
    path,
    glob: include,
    output_mode: "files_with_matches",
  };

  return grep(grepArgs);
}
