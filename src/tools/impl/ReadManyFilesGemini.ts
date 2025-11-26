/**
 * Gemini CLI read_many_files tool - new implementation for Letta Code
 * Uses Gemini's exact schema and description
 */

import path from "node:path";
import { glob as globFn } from "glob";
import { read } from "./Read";

interface ReadManyFilesGeminiArgs {
  include: string[];
  exclude?: string[];
  recursive?: boolean;
  useDefaultExcludes?: boolean;
  file_filtering_options?: {
    respect_git_ignore?: boolean;
    respect_gemini_ignore?: boolean;
  };
}

const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/*.min.js",
  "**/*.bundle.js",
];

export async function read_many_files(
  args: ReadManyFilesGeminiArgs,
): Promise<{ message: string }> {
  const { include, exclude = [], useDefaultExcludes = true } = args;

  if (!Array.isArray(include) || include.length === 0) {
    throw new Error("include must be a non-empty array of glob patterns");
  }

  // Build ignore patterns
  const ignorePatterns = useDefaultExcludes
    ? [...DEFAULT_EXCLUDES, ...exclude]
    : exclude;

  const cwd = process.cwd();
  const allFiles = new Set<string>();

  // Process each include pattern
  for (const pattern of include) {
    const files = await globFn(pattern, {
      cwd,
      ignore: ignorePatterns,
      nodir: true,
      dot: true,
      absolute: true,
    });
    for (const f of files) {
      allFiles.add(f);
    }
  }

  const sortedFiles = Array.from(allFiles).sort();

  if (sortedFiles.length === 0) {
    return {
      message: `No files matching the criteria were found or all were skipped.`,
    };
  }

  // Read all files and concatenate
  const contentParts: string[] = [];
  const skippedFiles: Array<{ path: string; reason: string }> = [];

  for (const filePath of sortedFiles) {
    try {
      const _relativePath = path.relative(cwd, filePath);
      const separator = `--- ${filePath} ---`;

      // Use our Read tool to read the file
      const result = await read({ file_path: filePath });
      const content = result.content;

      contentParts.push(`${separator}\n\n${content}\n\n`);
    } catch (error) {
      const relativePath = path.relative(cwd, filePath);
      skippedFiles.push({
        path: relativePath,
        reason:
          error instanceof Error ? error.message : "Unknown error reading file",
      });
    }
  }

  contentParts.push("--- End of content ---");

  const processedCount = sortedFiles.length - skippedFiles.length;
  let _displayMessage = `Successfully read and concatenated content from **${processedCount} file(s)**.`;

  if (skippedFiles.length > 0) {
    _displayMessage += `\n\n**Skipped ${skippedFiles.length} file(s):**`;
    skippedFiles.slice(0, 5).forEach((f) => {
      _displayMessage += `\n- \`${f.path}\` (${f.reason})`;
    });
    if (skippedFiles.length > 5) {
      _displayMessage += `\n- ...and ${skippedFiles.length - 5} more`;
    }
  }

  const message = contentParts.join("");

  return { message };
}
