import { getCurrentAgentId } from "@/agent/context";
import { extractApplyPatchPaths, extractFilePath } from "./cross-agent-guard";
import {
  isPathWithinRoots,
  resolveAllowedMemoryRoots,
  resolveMemoryTargetPath,
} from "./memory-paths";
import { canonicalizeRoot } from "./sandbox-policy";

type ToolArgs = Record<string, unknown>;

/**
 * File-write tools (by canonical name) whose edits inside the agent's own
 * memory checkout are allowed like memory-dir shell commands. Codex writes
 * memory through ApplyPatch rather than Edit/Write.
 */
export const MEMORY_FILE_WRITE_TOOLS = new Set(["Write", "Edit", "ApplyPatch"]);

/** Every path a file-write tool touches; a patch may carry several. */
function writeTargets(canonicalTool: string, toolArgs: ToolArgs): string[] {
  if (canonicalTool === "ApplyPatch") {
    return typeof toolArgs.input === "string"
      ? extractApplyPatchPaths(toolArgs.input)
      : [];
  }
  const filePath = extractFilePath(toolArgs);
  return filePath ? [filePath] : [];
}

/**
 * True when every target of the write lies inside the agent's own memory
 * roots, both as written and after resolving symlinks (tolerating a
 * not-yet-existing leaf), so a link planted under the checkout cannot route
 * an auto-approved edit elsewhere. The cross-agent guard runs before this and
 * the MemFS pre-commit hook still protects read_only files.
 */
export function isOwnMemoryWrite(
  canonicalTool: string,
  toolArgs: ToolArgs,
  workingDirectory: string,
  agentId?: string,
): boolean {
  if (!MEMORY_FILE_WRITE_TOOLS.has(canonicalTool)) return false;
  const targets = writeTargets(canonicalTool, toolArgs);
  if (targets.length === 0) return false;
  try {
    const { roots } = resolveAllowedMemoryRoots({
      currentAgentId: agentId ?? getCurrentAgentId(),
    });
    const realRoots = roots.map(canonicalizeRoot);
    return targets.every((target) => {
      const resolved = resolveMemoryTargetPath(target, workingDirectory);
      return (
        resolved !== null &&
        isPathWithinRoots(resolved, roots) &&
        isPathWithinRoots(canonicalizeRoot(resolved), realRoots)
      );
    });
  } catch {
    return false;
  }
}
