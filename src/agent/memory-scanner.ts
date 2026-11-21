
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface TreeNode {
  name: string; // Display name (e.g., "git.md" or "dev_workflow/")
  relativePath: string; // Relative path from memory root
  fullPath: string; // Full filesystem path
  isDirectory: boolean;
  depth: number;
  isLast: boolean;
  parentIsLast: boolean[];
}

export function scanMemoryFilesystem(memoryRoot: string): TreeNode[] {
  const nodes: TreeNode[] = [];

  const scanDir = (dir: string, depth: number, parentIsLast: boolean[]) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    const filtered = entries.filter((name) => !name.startsWith("."));

    // Sort: directories first, "system" always first among dirs, then alphabetically
    const sorted = filtered.sort((a, b) => {
      const aPath = join(dir, a);
      const bPath = join(dir, b);
      let aIsDir = false;
      let bIsDir = false;
      try {
        aIsDir = statSync(aPath).isDirectory();
      } catch {}
      try {
        bIsDir = statSync(bPath).isDirectory();
      } catch {}
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      if (aIsDir && bIsDir && depth === 0) {
        if (a === "system") return -1;
        if (b === "system") return 1;
      }
      return a.localeCompare(b);
    });

    sorted.forEach((name, index) => {
      const fullPath = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(fullPath).isDirectory();
      } catch {
        return; // Skip if we can't stat
      }

      const relativePath = relative(memoryRoot, fullPath).replace(/\\/g, "/");
      const isLast = index === sorted.length - 1;

      nodes.push({
        name: isDir ? `${name}/` : name,
        relativePath,
        fullPath,
        isDirectory: isDir,
        depth,
        isLast,
        parentIsLast: [...parentIsLast],
      });

      if (isDir) {
        scanDir(fullPath, depth + 1, [...parentIsLast, isLast]);
      }
    });
  };

  scanDir(memoryRoot, 0, []);
  return nodes;
}

export function getFileNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.filter((n) => !n.isDirectory);
}

export function readFileContent(fullPath: string): string {
  try {
    return readFileSync(fullPath, "utf-8");
  } catch {
    return "(unable to read file)";
  }
}
