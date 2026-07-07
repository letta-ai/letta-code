import { statSync } from "node:fs";

/** True when the path exists and is a directory. */
export function isUsableDirectory(dirPath: string | null | undefined): boolean {
  if (typeof dirPath !== "string" || dirPath.length === 0) {
    return false;
  }

  try {
    return statSync(dirPath, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}
