import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LIMITS, truncateArray } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";

const execFileAsync = promisify(execFile);

function getRipgrepPath(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const require = createRequire(__filename);
    const rgPackage = require("@vscode/ripgrep");
    return rgPackage.rgPath;
  } catch (_error) {
    return "rg";
  }
}

const rgPath = getRipgrepPath();

interface GlobArgs {
  pattern: string;
  path?: string;
}

interface GlobResult {
  files: string[];
  truncated?: boolean;
  totalFiles?: number;
}

function applyFileLimit(files: string[], workingDirectory: string): GlobResult {
  const totalFiles = files.length;
  if (totalFiles <= LIMITS.GLOB_MAX_FILES) {
    return { files };
  }

  const { content, wasTruncated } = truncateArray(
    files,
    LIMITS.GLOB_MAX_FILES,
    (items) => items.join("\n"),
    "files",
    "Glob",
    { workingDirectory, toolName: "Glob" },
  );

  // Split the content back into an array of file paths + notice
  const resultFiles = content.split("\n");

  return {
    files: resultFiles,
    truncated: wasTruncated,
    totalFiles,
  };
}

export async function glob(args: GlobArgs): Promise<GlobResult> {
  validateRequiredParams(args, ["pattern"], "Glob");
  const { pattern, path: searchPath } = args;

  // Explicit check for undefined/empty pattern (validateRequiredParams only checks key existence)
  if (!pattern) {
    throw new Error("Glob tool missing required parameter: pattern");
  }
  const userCwd = process.env.USER_CWD || process.cwd();

  const baseDir = searchPath
    ? path.isAbsolute(searchPath)
      ? searchPath
      : path.resolve(userCwd, searchPath)
    : userCwd;

  // Build ripgrep args for file listing
  // --files: list files instead of searching content
  // --glob: filter by pattern
  // --hidden: include hidden files (dotfiles)
  // --follow: follow symlinks
  // --no-messages: suppress error messages for unreadable dirs
  const rgArgs = [
    "--files",
    "--hidden",
    "--follow",
    "--no-messages",
    "--glob",
    pattern,
    baseDir,
  ];

  try {
    const { stdout } = await execFileAsync(rgPath, rgArgs, {
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large file lists
      cwd: userCwd,
    });

    const files = stdout.trim().split("\n").filter(Boolean).sort();

    return applyFileLimit(files, userCwd);
  } catch (error) {
    const err = error as Error & {
      stdout?: string;
      code?: string | number;
    };

    // ripgrep exits with code 1 when no files match - that's not an error
    if (err.code === 1 || err.code === "1") {
      return { files: [] };
    }

    // If stdout has content despite error, use it (partial results)
    if (err.stdout?.trim()) {
      const files = err.stdout.trim().split("\n").filter(Boolean).sort();
      return applyFileLimit(files, userCwd);
    }

    throw new Error(`Glob failed: ${err.message || "Unknown error"}`);
  }
}
