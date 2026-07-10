import { isUsableDirectory } from "@/helpers/usable-directory";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { debugWarn } from "@/utils/debug";
import type { SubagentLaunchProfile } from ".";

export interface SubagentMemoryScope {
  primaryRoot: string | null;
  writableRoots: string[];
  readonlyRoots?: string[];
}

/**
 * USER_CWD is captured at session start and can be deleted mid-session
 * (e.g. `git worktree remove`); spawning a child with a dead cwd fails
 * with ENOENT before the subagent runs.
 */
function pickUsableSubagentCwd(
  candidate: string | undefined | null,
  fallbackCwd: string,
): string {
  if (candidate && isUsableDirectory(candidate)) {
    return candidate;
  }
  if (candidate) {
    debugWarn(
      "subagent",
      `Subagent working directory ${candidate} no longer exists; falling back to ${fallbackCwd}`,
    );
  }
  return fallbackCwd;
}

export function resolveSubagentWorkingDirectory(
  env: NodeJS.ProcessEnv = process.env,
  fallbackCwd: string = getCurrentWorkingDirectory(),
  options: {
    subagentType?: string;
    launchProfile?: SubagentLaunchProfile;
    inheritedPrimaryRoot?: string | null;
    memoryScope?: SubagentMemoryScope;
  } = {},
): string {
  if (
    options.subagentType === "reflection" &&
    options.launchProfile === "memory-subagent" &&
    options.memoryScope
  ) {
    return pickUsableSubagentCwd(env.USER_CWD, fallbackCwd);
  }

  const primaryRoot =
    options.memoryScope?.primaryRoot ?? options.inheritedPrimaryRoot;
  if (
    options.subagentType === "reflection" &&
    options.launchProfile === "memory-subagent" &&
    primaryRoot &&
    isUsableDirectory(primaryRoot)
  ) {
    return primaryRoot;
  }

  return pickUsableSubagentCwd(env.USER_CWD, fallbackCwd);
}
