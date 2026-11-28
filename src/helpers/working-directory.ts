import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

export async function resolveWorkingDirectory(
  requestedPath: string,
  currentWorkingDirectory: string,
): Promise<string> {
  const expanded = expandHome(requestedPath);
  const resolved = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(currentWorkingDirectory, expanded);
  return resolveTraversableDirectory(resolved);
}

export async function resolveTraversableDirectory(
  resolvedPath: string,
): Promise<string> {
  const normalized = await realpath(resolvedPath);
  const stats = await stat(normalized);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${normalized}`);
  }
  if (process.platform !== "win32") {
    try {
      await access(normalized, constants.X_OK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "EACCES" || code === "EPERM") {
        throw new Error(
          `Permission denied: cannot traverse directory ${normalized}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
  return normalized;
}
