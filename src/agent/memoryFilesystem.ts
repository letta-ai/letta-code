/**
 * Memory filesystem helpers.
 *
 * With git-backed memory, most sync/hash logic is removed.
 * This module retains: directory helpers and tree rendering.
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
