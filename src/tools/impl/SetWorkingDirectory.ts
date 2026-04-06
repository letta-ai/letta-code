import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { getIndexRoot, setIndexRoot } from "../../cli/helpers/fileIndex";
import { getExecutionContextCwdChanger } from "../manager";
import { validateRequiredParams } from "./validation";

interface SetWorkingDirectoryArgs {
  path: string;
  /** Injected by executeTool — do not pass manually */
  _executionContextId?: string;
}

interface SetWorkingDirectoryResult {
  status: string;
  message: string;
  previous_cwd: string;
  new_cwd: string;
}

export async function set_working_directory(
  args: SetWorkingDirectoryArgs,
): Promise<SetWorkingDirectoryResult> {
  validateRequiredParams(args, ["path"], "SetWorkingDirectory");

  const requestedPath = args.path?.trim();
  if (!requestedPath) {
    throw new Error("Working directory path cannot be empty");
  }

  const currentCwd = process.env.USER_CWD || process.cwd();

  // Resolve relative paths against current working directory
  const resolvedPath = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(currentCwd, requestedPath);

  // Validate the path exists and is a directory
  let normalizedPath: string;
  try {
    normalizedPath = await realpath(resolvedPath);
  } catch {
    throw new Error(`Path does not exist: ${resolvedPath}`);
  }

  const stats = await stat(normalizedPath);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${normalizedPath}`);
  }

  // Update the execution context so subsequent tools in this turn use the new cwd
  const cwdChanger = args._executionContextId
    ? getExecutionContextCwdChanger(args._executionContextId)
    : undefined;

  if (cwdChanger) {
    cwdChanger(normalizedPath);
  }

  // Also update process.env.USER_CWD as immediate fallback
  process.env.USER_CWD = normalizedPath;

  // Re-root the file index if the new cwd is outside the current root
  const currentRoot = getIndexRoot();
  if (!normalizedPath.startsWith(currentRoot)) {
    setIndexRoot(normalizedPath);
  }

  return {
    status: "OK",
    message: `Working directory changed to ${normalizedPath}`,
    previous_cwd: currentCwd,
    new_cwd: normalizedPath,
  };
}
