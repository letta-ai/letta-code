import { getCurrentAgentId } from "@/agent/context";
import { extractApplyPatchPaths, extractFilePath } from "./cross-agent-guard";
import {
  isPathWithinRoots,
  resolveAllowedMemoryRoots,
  resolveMemoryTargetPath,
} from "./memory-paths";
import { canonicalizeRoot } from "./sandbox-policy";

type ToolArgs = Record<string, unknown>;

export const MEMORY_FILE_WRITE_TOOLS = new Set(["Write", "Edit", "ApplyPatch"]);

function writeTargets(canonicalTool: string, toolArgs: ToolArgs): string[] {
  if (canonicalTool === "ApplyPatch") {
    return typeof toolArgs.input === "string"
      ? extractApplyPatchPaths(toolArgs.input)
      : [];
  }
  const filePath = extractFilePath(toolArgs);
  return filePath ? [filePath] : [];
}

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
