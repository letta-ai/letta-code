import { homedir } from "node:os";
import { expandFilePath } from "@/utils/file-path";
import { canonicalizeRoot } from "./sandbox-policy";

const FILE_PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

type ToolArgs = Record<string, unknown>;

/** Expand and canonicalize the path arguments shared by in-process file tools. */
export function canonicalizeFilePathArgs(
  toolArgs: ToolArgs,
  workingDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): ToolArgs {
  let canonicalArgs = toolArgs;
  for (const key of FILE_PATH_KEYS) {
    const value = toolArgs[key];
    if (typeof value !== "string" || value.length === 0) continue;
    // Preserve Windows paths in cross-platform permission tests and remote
    // requests evaluated by a non-Windows host.
    if (process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(value)) {
      continue;
    }
    canonicalArgs = {
      ...canonicalArgs,
      [key]: canonicalizeRoot(
        expandFilePath(
          value,
          workingDirectory,
          env,
          homeDir ?? env.HOME ?? homedir(),
        ),
      ),
    };
  }
  return canonicalArgs;
}
