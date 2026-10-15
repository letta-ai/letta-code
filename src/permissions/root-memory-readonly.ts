import { lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConversationId } from "@/agent/context";
import { buildFsSandboxPolicy, type FsSandboxPolicy } from "@/sandbox/policy";
import { canonicalToolName } from "./canonical";
import { extractApplyPatchPaths, extractFilePath } from "./cross-agent-guard";
import {
  resolveAllowedMemoryRoots,
  resolveMemoryTargetPath,
} from "./memory-paths";
import { canonicalizeRoot } from "./sandbox-policy";

/** Set by the managed sandbox launcher, not by model tool arguments. */
export function resolveReadonlyMemoryRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const conversation = env.LETTA_READONLY_ROOT_MEMORY_CONVERSATION;
  if (!conversation || conversation !== getConversationId()) return null;
  const root = resolveAllowedMemoryRoots({ env }).primaryRoot;
  if (!root)
    throw new Error("Read-only root memory requires a memory directory");
  return canonicalizeRoot(root);
}

/** Mount the directory read-only, then restore existing child directories.
 * This prevents replacing/deleting root files or creating new ones, while
 * leaving deferred memory and Git metadata writable. Trusted sync stays in
 * the parent process, outside the tool's mount namespace.
 */
export function buildRootMemoryReadonlyPolicy(root: string): FsSandboxPolicy {
  const entries = readdirSync(root, { withFileTypes: true });
  const readonlyRoots = [root];
  for (const entry of entries) {
    // A root symlink must not turn a protected path into a writable alias.
    if (entry.isSymbolicLink()) {
      readonlyRoots.push(canonicalizeRoot(join(root, entry.name)));
    }
  }
  return buildFsSandboxPolicy({
    readonlyRoots,
    writableRoots: entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name)),
  });
}

/** File tools execute in the trusted harness rather than a subprocess. */
export function evaluateRootMemoryReadonlyGuard(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  root: string | null = resolveReadonlyMemoryRoot(),
): { matchedRule: string; reason: string } | null {
  if (!root) return null;
  const tool = canonicalToolName(toolName);
  if (!["Write", "Edit", "ApplyPatch"].includes(tool)) return null;
  const file = extractFilePath(args);
  const paths =
    tool === "ApplyPatch"
      ? typeof args.input === "string"
        ? extractApplyPatchPaths(args.input)
        : []
      : file
        ? [file]
        : [];
  for (const path of paths) {
    const lexical = resolveMemoryTargetPath(path, cwd);
    if (!lexical) continue;
    if (
      [lexical, canonicalizeRoot(lexical)].some(
        (target) =>
          target === root ||
          dirname(target) === root ||
          (target.startsWith(`${root}/`) &&
            !lstatSync(
              join(root, target.slice(root.length + 1).split("/")[0] ?? ""),
              { throwIfNoEntry: false },
            )?.isDirectory()),
      )
    ) {
      return {
        matchedRule: "read-only root memory",
        reason:
          "Root memory files are read-only in this conversation. Delegate the update to a memory worker.",
      };
    }
  }
  return null;
}
