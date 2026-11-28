import { accessSync, constants, type Stats, statSync } from "node:fs";

export type DirectoryUsability =
  | "usable"
  | "missing"
  | "not-directory"
  | "inaccessible"
  | "unknown";

type DirectoryStat = (
  dirPath: string,
) => Pick<Stats, "isDirectory"> | undefined;

function readDirectoryStats(dirPath: string): Stats | undefined {
  return statSync(dirPath, { throwIfNoEntry: false });
}

function checkDirectoryTraversal(dirPath: string): void {
  if (process.platform !== "win32") {
    accessSync(dirPath, constants.X_OK);
  }
}

export function getDirectoryUsability(
  dirPath: string | null | undefined,
  statDirectory: DirectoryStat = readDirectoryStats,
  checkTraversal: (dirPath: string) => void = checkDirectoryTraversal,
): DirectoryUsability {
  if (typeof dirPath !== "string" || dirPath.length === 0) {
    return "missing";
  }

  try {
    const stats = statDirectory(dirPath);
    if (!stats) {
      return "missing";
    }
    if (!stats.isDirectory()) {
      return "not-directory";
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
  }

  try {
    checkTraversal(dirPath);
    return "usable";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "EACCES" || code === "EPERM" ? "inaccessible" : "unknown";
  }
}

export function isConfirmedUnusableDirectory(
  dirPath: string | null | undefined,
  statDirectory?: DirectoryStat,
): boolean {
  const usability = getDirectoryUsability(dirPath, statDirectory);
  return usability === "missing" || usability === "not-directory";
}

export function isUsableDirectory(dirPath: string | null | undefined): boolean {
  return getDirectoryUsability(dirPath) === "usable";
}
