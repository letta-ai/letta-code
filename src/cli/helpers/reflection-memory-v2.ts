import { readFile } from "node:fs/promises";
import { isCoreMemoryPath, isProjectedMemoryPath } from "@/agent/memory-format";
import {
  getFileNodes,
  scanMemoryFilesystem,
  type TreeNode,
} from "@/agent/memory-scanner";
import { REFLECTION_PARENT_MEMORY_SNAPSHOT_CHAR_LIMIT } from "@/agent/subagents/context-budget";

function renderProjectedTree(files: TreeNode[]): string {
  type MemoryTree = { directories: Map<string, MemoryTree>; files: string[] };
  const root: MemoryTree = { directories: new Map(), files: [] };
  for (const file of files) {
    const parts = file.relativePath.replace(/\\/g, "/").split("/");
    const fileName = parts.pop();
    let current = root;
    for (const directory of parts) {
      let child = current.directories.get(directory);
      if (!child) {
        child = { directories: new Map(), files: [] };
        current.directories.set(directory, child);
      }
      current = child;
    }
    if (fileName) current.files.push(fileName);
  }
  const lines = ["/memory/"];
  const render = (tree: MemoryTree, indent: string) => {
    for (const [name, child] of [...tree.directories].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`${indent}├── ${name}/`);
      render(child, `${indent}│   `);
    }
    for (const name of tree.files.sort((a, b) => a.localeCompare(b))) {
      lines.push(`${indent}├── ${name}`);
    }
  };
  render(root, "");
  return lines.join("\n");
}

export async function buildMemfsV2ParentMemorySnapshot(
  memoryDir: string,
  requestedMaxChars?: number,
): Promise<string> {
  const allFileNodes = getFileNodes(scanMemoryFilesystem(memoryDir));
  const allPaths = new Set(
    allFileNodes.map((node) => node.relativePath.replace(/\\/g, "/")),
  );
  const projectedFiles = allFileNodes.filter(
    (node) =>
      node.name.endsWith(".md") &&
      isProjectedMemoryPath(node.relativePath, allPaths, "memfs-v2"),
  );
  const maxChars = Math.max(
    1_000,
    requestedMaxChars ?? REFLECTION_PARENT_MEMORY_SNAPSHOT_CHAR_LIMIT,
  );
  const lines = [
    "<parent_memory>",
    "<memory_filesystem>",
    renderProjectedTree(projectedFiles),
    "</memory_filesystem>",
  ];

  for (const file of projectedFiles.filter((node) =>
    isCoreMemoryPath(node.relativePath, "memfs-v2"),
  )) {
    const prefix = `<memory>\n<path>$MEMORY_DIR/${file.relativePath}</path>\n`;
    const suffix = "\n</memory>";
    const remaining =
      maxChars - lines.join("\n").length - prefix.length - suffix.length - 20;
    if (remaining <= 0) break;
    const content = (await readFile(file.fullPath, "utf-8")).slice(
      0,
      remaining,
    );
    lines.push(`${prefix}${content}${suffix}`);
  }

  lines.push("</parent_memory>");
  return lines.join("\n");
}
