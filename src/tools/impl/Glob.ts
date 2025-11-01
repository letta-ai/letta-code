import { promises as fs } from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";
import { LIMITS } from "./truncation.js";
import { validateRequiredParams } from "./validation.js";

interface GlobArgs {
  pattern: string;
  path?: string;
}
interface GlobResult {
  files: string[];
  truncated?: boolean;
  totalFiles?: number;
}

function applyFileLimit(files: string[]): GlobResult {
  const totalFiles = files.length;
  if (totalFiles <= LIMITS.GLOB_MAX_FILES) {
    return { files };
  }

  const truncatedFiles = files.slice(0, LIMITS.GLOB_MAX_FILES);
  // Add truncation notice as last entry
  truncatedFiles.push(
    `\n[Output truncated: showing ${LIMITS.GLOB_MAX_FILES.toLocaleString()} of ${totalFiles.toLocaleString()} files.]`,
  );

  return {
    files: truncatedFiles,
    truncated: true,
    totalFiles,
  };
}

async function walkDirectory(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const subFiles = await walkDirectory(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EACCES" && err.code !== "EPERM") throw err;
  }
  return files;
}

export async function glob(args: GlobArgs): Promise<GlobResult> {
  validateRequiredParams(args, ["pattern"], "Glob");
  const { pattern, path: searchPath } = args;
  const userCwd = process.env.USER_CWD || process.cwd();
  let baseDir: string;
  if (searchPath)
    baseDir = path.isAbsolute(searchPath)
      ? searchPath
      : path.resolve(userCwd, searchPath);
  else baseDir = userCwd;
  try {
    const stats = await fs.stat(baseDir);
    if (!stats.isDirectory())
      throw new Error(`Path is not a directory: ${baseDir}`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT")
      throw new Error(`Directory does not exist: ${baseDir}`);
    throw err;
  }
  const allFiles = await walkDirectory(baseDir);
  let matcher: (input: string) => boolean;
  if (pattern.startsWith("**/")) {
    const subPattern = pattern.slice(3);
    matcher = picomatch(subPattern);
    const matchedFiles = allFiles.filter((file) =>
      matcher(path.basename(file)),
    );
    return applyFileLimit(matchedFiles.sort());
  } else if (pattern.includes("**")) {
    const fullPattern = path.join(baseDir, pattern);
    matcher = picomatch(fullPattern, { dot: true });
    const matchedFiles = allFiles.filter((file) => matcher(file));
    return applyFileLimit(matchedFiles.sort());
  } else {
    matcher = picomatch(pattern, { dot: true });
    const matchedFiles = allFiles.filter((file) =>
      matcher(path.relative(baseDir, file)),
    );
    return applyFileLimit(matchedFiles.sort());
  }
}
