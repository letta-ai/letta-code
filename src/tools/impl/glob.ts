import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { ensureRipgrep } from "./ripgrep-manager.js";
import { LIMITS, truncateArray } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";

const execFileAsync = promisify(execFile);

interface GlobArgs {
  pattern: string;
  path?: string;
  signal?: AbortSignal;
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
    { workingDirectory },
  );

  const resultFiles = content.split("\n");

  return {
    files: resultFiles,
    truncated: wasTruncated,
    totalFiles,
  };
}

export async function glob(args: GlobArgs): Promise<GlobResult> {
  validateRequiredParams(args, ["pattern"], "Glob");
  const { pattern, path: searchPath, signal } = args;

  if (!pattern) {
    throw new Error("Glob tool missing required parameter: pattern");
  }
  const userCwd = getCurrentWorkingDirectory();
  const rgPath = await ensureRipgrep(true);
  if (!rgPath) {
    throw new Error(
      "Glob failed: ripgrep (rg) is not available and could not be downloaded",
    );
  }

  const baseDir = searchPath
    ? path.isAbsolute(searchPath)
      ? searchPath
      : path.resolve(userCwd, searchPath)
    : userCwd;

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
      maxBuffer: 50 * 1024 * 1024,
      cwd: userCwd,
      signal,
    });

    const files = stdout.trim().split("\n").filter(Boolean).sort();

    return applyFileLimit(files, userCwd);
  } catch (error) {
    if (signal?.aborted) {
      signal.throwIfAborted();
    }
    const err = error as Error & {
      stdout?: string;
      code?: string | number;
    };

    if (err.code === 1 || err.code === "1") {
      return { files: [] };
    }

    if (err.stdout?.trim()) {
      const files = err.stdout.trim().split("\n").filter(Boolean).sort();
      return applyFileLimit(files, userCwd);
    }

    throw new Error(`Glob failed: ${err.message || "Unknown error"}`);
  }
}
