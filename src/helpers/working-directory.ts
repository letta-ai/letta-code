import { realpath, stat } from "node:fs/promises";
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
  const normalized = await realpath(resolved);
  const stats = await stat(normalized);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${normalized}`);
  }
  return normalized;
}
