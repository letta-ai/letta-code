import { type Stats, statSync } from "node:fs";

export type DirectoryUsability =
  | "usable"
  | "missing"
  | "not-directory"
  | "unknown";

type DirectoryStat = (
  dirPath: string,
) => Pick<Stats, "isDirectory"> | undefined;

function readDirectoryStats(dirPath: string): Stats | undefined {
  return statSync(dirPath, { throwIfNoEntry: false });
}

export function getDirectoryUsability(
  dirPath: string | null | undefined,
  statDirectory: DirectoryStat = readDirectoryStats,
): DirectoryUsability {
  if (typeof dirPath !== "string" || dirPath.length === 0) {
    return "missing";
  }

  try {
    const stats = statDirectory(dirPath);
    if (!stats) {
      return "missing";
    }
    return stats.isDirectory() ? "usable" : "not-directory";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
  }
}

export function isConfirmedUnusableDirectory(
  dirPath: string | null | undefined,
  statDirectory?: DirectoryStat,
): boolean {
  const usability = getDirectoryUsability(dirPath, statDirectory);
  return usability === "missing" || usability === "not-directory";
}

/** True when the path exists and is a directory. */
export function isUsableDirectory(dirPath: string | null | undefined): boolean {
  return getDirectoryUsability(dirPath) === "usable";
}
