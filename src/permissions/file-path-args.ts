import { homedir } from "node:os";
import { expandFilePath } from "@/utils/file-path";
import { canonicalToolName } from "./canonical";

const FILE_PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

type ToolArgs = Record<string, unknown>;

const CWD_FILE_PATH_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "ListDir",
  "ReadLSP",
  "ViewImage",
  "SetWorkingDirectory",
  "EnterWorktree",
]);

/** Expand cwd-relative path arguments shared by in-process file tools. */
export function expandPathArgs(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): ToolArgs {
  if (!CWD_FILE_PATH_TOOLS.has(canonicalToolName(toolName))) return toolArgs;
  let expandedArgs = toolArgs;
  for (const key of FILE_PATH_KEYS) {
    const value = toolArgs[key];
    if (typeof value !== "string" || value.length === 0) continue;
    // Preserve Windows paths in cross-platform permission tests and remote
    // requests evaluated by a non-Windows host.
    if (process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(value)) {
      continue;
    }
    expandedArgs = {
      ...expandedArgs,
      [key]: expandFilePath(
        value,
        workingDirectory,
        env,
        homeDir ?? env.HOME ?? homedir(),
      ),
    };
  }
  return expandedArgs;
}
