import { type GrepArgs, grep } from "./Grep.js";
import { validateRequiredParams } from "./validation.js";

interface GrepFilesArgs {
  pattern: string;
  include?: string;
  path?: string;
  limit?: number;
}

interface GrepFilesResult {
  output: string;
  matches?: number;
  files?: number;
  truncated?: boolean;
}

const DEFAULT_LIMIT = 100;

/**
 * Codex-style grep_files tool.
 * Uses the existing Grep implementation and returns a list of files with matches.
 */
export async function grep_files(
  args: GrepFilesArgs,
): Promise<GrepFilesResult> {
  validateRequiredParams(args, ["pattern"], "grep_files");

  const { pattern, include, path, limit = DEFAULT_LIMIT } = args;

  const grepArgs: GrepArgs = {
    pattern,
    path,
    glob: include,
    output_mode: "files_with_matches",
  };

  const result = await grep(grepArgs);

  // The underlying grep result already has the correct files count
  const totalFiles = result.files ?? 0;

  // Apply limit to the file list
  if (result.output && limit > 0 && totalFiles > limit) {
    // The output format is: "Found N files\n/path/to/file1\n/path/to/file2..."
    const lines = result.output
      .split("\n")
      .filter((line) => line.trim() !== "");

    // First line is "Found N files", rest are file paths
    const filePaths = lines.slice(1);

    const truncatedFiles = filePaths.slice(0, limit);
    const truncatedOutput = `Found ${limit} file${limit !== 1 ? "s" : ""} (truncated from ${totalFiles})\n${truncatedFiles.join("\n")}`;

    return {
      output: truncatedOutput,
      files: limit,
      truncated: true,
    };
  }

  return {
    output: result.output,
    files: totalFiles,
    truncated: false,
  };
}
