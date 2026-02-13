/**
 * Memory filesystem helpers.
 *
 * With git-backed memory, most sync/hash logic is removed.
 * This module retains: directory helpers, tree rendering, and
 * the shared memfs initialization logic used by both interactive
 * and headless code paths.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MEMORY_FS_ROOT = ".letta";
export const MEMORY_FS_AGENTS_DIR = "agents";
export const MEMORY_FS_MEMORY_DIR = "memory";
export const MEMORY_SYSTEM_DIR = "system";

// ----- Directory helpers -----

export function getMemoryFilesystemRoot(
  agentId: string,
  homeDir: string = homedir(),
): string {
  return join(
    homeDir,
    MEMORY_FS_ROOT,
    MEMORY_FS_AGENTS_DIR,
    agentId,
    MEMORY_FS_MEMORY_DIR,
  );
}

export function getMemorySystemDir(
  agentId: string,
  homeDir: string = homedir(),
): string {
  return join(getMemoryFilesystemRoot(agentId, homeDir), MEMORY_SYSTEM_DIR);
}

export function ensureMemoryFilesystemDirs(
  agentId: string,
  homeDir: string = homedir(),
): void {
  const root = getMemoryFilesystemRoot(agentId, homeDir);
  const systemDir = getMemorySystemDir(agentId, homeDir);

  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  if (!existsSync(systemDir)) {
    mkdirSync(systemDir, { recursive: true });
  }
}

// ----- Path helpers -----

export function labelFromRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.replace(/\.md$/, "");
}

// ----- Tree rendering -----

/**
 * Render a tree visualization of the memory filesystem.
 * Takes system labels (under system/) and detached labels (at root).
 */
export function renderMemoryFilesystemTree(
  systemLabels: string[],
  detachedLabels: string[],
): string {
  type TreeNode = { children: Map<string, TreeNode>; isFile: boolean };

  const makeNode = (): TreeNode => ({ children: new Map(), isFile: false });
  const root = makeNode();

  const insertPath = (base: string | null, label: string) => {
    const parts = base ? [base, ...label.split("/")] : label.split("/");
    let current = root;
    for (const [i, partName] of parts.entries()) {
      const part = i === parts.length - 1 ? `${partName}.md` : partName;
      if (!current.children.has(part)) {
        current.children.set(part, makeNode());
      }
      current = current.children.get(part) as TreeNode;
      if (i === parts.length - 1) {
        current.isFile = true;
      }
    }
  };

  for (const label of systemLabels) {
    insertPath(MEMORY_SYSTEM_DIR, label);
  }
  for (const label of detachedLabels) {
    insertPath(null, label);
  }

  // Always show system/ directory even if empty
  if (!root.children.has(MEMORY_SYSTEM_DIR)) {
    root.children.set(MEMORY_SYSTEM_DIR, makeNode());
  }

  const sortedEntries = (node: TreeNode) => {
    const entries = Array.from(node.children.entries());
    return entries.sort(([nameA, nodeA], [nameB, nodeB]) => {
      if (nodeA.isFile !== nodeB.isFile) {
        return nodeA.isFile ? 1 : -1;
      }
      return nameA.localeCompare(nameB);
    });
  };

  const lines: string[] = ["/memory/"];

  const render = (node: TreeNode, prefix: string) => {
    const entries = sortedEntries(node);
    entries.forEach(([name, child], index) => {
      const isLast = index === entries.length - 1;
      const branch = isLast ? "└──" : "├──";
      lines.push(`${prefix}${branch} ${name}${child.isFile ? "" : "/"}`);
      if (child.children.size > 0) {
        const nextPrefix = `${prefix}${isLast ? "    " : "│   "}`;
        render(child, nextPrefix);
      }
    });
  };

  render(root, "");

  return lines.join("\n");
}

// ----- Shared memfs initialization -----

export interface ApplyMemfsFlagsResult {
  /** Whether memfs was enabled, disabled, or unchanged */
  action: "enabled" | "disabled" | "unchanged";
  /** Path to the memory directory (when enabled) */
  memoryDir?: string;
  /** Summary from git pull (when pullOnExistingRepo is true and repo already existed) */
  pullSummary?: string;
}

/**
 * Apply --memfs / --no-memfs CLI flags (or /memfs enable) to an agent.
 *
 * Shared between interactive (index.ts), headless (headless.ts), and
 * the /memfs enable command (App.tsx) to avoid duplicating the setup logic.
 *
 * Steps when enabling:
 *   1. Validate Letta Cloud requirement
 *   2. Persist memfs setting
 *   3. Detach old API-based memory tools
 *   4. Update system prompt to include memfs section
 *   5. Add git-memory-enabled tag + clone/pull repo
 *
 * @throws {Error} if Letta Cloud validation fails or git setup fails
 */
export async function applyMemfsFlags(
  agentId: string,
  memfsFlag: boolean | undefined,
  noMemfsFlag: boolean | undefined,
  options?: { pullOnExistingRepo?: boolean },
): Promise<ApplyMemfsFlagsResult> {
  const { getServerUrl } = await import("./client");
  const { settingsManager } = await import("../settings-manager");

  // 1. Validate + persist setting
  if (memfsFlag) {
    const serverUrl = getServerUrl();
    if (!serverUrl.includes("api.letta.com")) {
      throw new Error(
        "--memfs is only available on Letta Cloud (api.letta.com).",
      );
    }
    settingsManager.setMemfsEnabled(agentId, true);
  } else if (noMemfsFlag) {
    settingsManager.setMemfsEnabled(agentId, false);
  }

  const isEnabled = settingsManager.isMemfsEnabled(agentId);

  // 2. Detach old API-based memory tools when enabling
  if (isEnabled && memfsFlag) {
    const { detachMemoryTools } = await import("../tools/toolset");
    await detachMemoryTools(agentId);
  }

  // 3. Update system prompt to include/exclude memfs section
  if (memfsFlag || noMemfsFlag) {
    const { updateAgentSystemPromptMemfs } = await import("./modify");
    await updateAgentSystemPromptMemfs(agentId, isEnabled);
  }

  // 4. Add git tag + clone/pull repo
  let pullSummary: string | undefined;
  if (isEnabled) {
    const { addGitMemoryTag, isGitRepo, cloneMemoryRepo, pullMemory } =
      await import("./memoryGit");
    await addGitMemoryTag(agentId);
    if (!isGitRepo(agentId)) {
      await cloneMemoryRepo(agentId);
    } else if (options?.pullOnExistingRepo) {
      const result = await pullMemory(agentId);
      pullSummary = result.summary;
    }
  }

  const action = memfsFlag ? "enabled" : noMemfsFlag ? "disabled" : "unchanged";
  return {
    action,
    memoryDir: isEnabled ? getMemoryFilesystemRoot(agentId) : undefined,
    pullSummary,
  };
}
