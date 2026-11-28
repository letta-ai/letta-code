import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MEMORY_SYSTEM_DIR } from "@/agent/memory-filesystem";
import type { LocalMemoryFormat } from "@/agent/memory-format";
import { isCoreMemoryPath, isProjectedMemoryPath } from "@/agent/memory-format";
import {
  getFileNodes,
  scanMemoryFilesystem,
  type TreeNode,
} from "@/agent/memory-scanner";
import { REFLECTION_PARENT_MEMORY_SNAPSHOT_CHAR_LIMIT } from "@/agent/subagents/context-budget";
import { getDirectoryLimits } from "@/utils/directory-limits";
import { parseFrontmatter } from "@/utils/frontmatter";

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

async function buildMemfsV2ParentMemorySnapshot(
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

interface ParentMemoryFile {
  relativePath: string;
  content: string;
  description?: string;
}

interface ParentMemorySnapshotOptions {
  maxChars?: number;
  memoryFormat?: LocalMemoryFormat;
}

function isSystemMemoryFile(relativePath: string): boolean {
  return relativePath.startsWith(`${MEMORY_SYSTEM_DIR}/`);
}

async function collectParentMemoryFiles(
  memoryDir: string,
): Promise<ParentMemoryFile[]> {
  const files: ParentMemoryFile[] = [];

  const walk = async (currentDir: string, relativeDir: string) => {
    let entries: Dirent[] = [];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    const sortedEntries = entries
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

    for (const entry of sortedEntries) {
      const entryPath = join(currentDir, entry.name);
      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        await walk(entryPath, relativePath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      try {
        const content = await readFile(entryPath, "utf-8");
        const { frontmatter } = parseFrontmatter(content);
        const description =
          typeof frontmatter.description === "string"
            ? frontmatter.description
            : undefined;
        files.push({
          relativePath: relativePath.replace(/\\/g, "/"),
          content,
          description,
        });
      } catch {}
    }
  };

  await walk(memoryDir, "");
  return files;
}

function buildParentMemoryTree(files: ParentMemoryFile[]): string {
  type TreeNode = {
    children: Map<string, TreeNode>;
    isFile: boolean;
    description?: string;
  };

  const makeNode = (): TreeNode => ({ children: new Map(), isFile: false });
  const root = makeNode();

  for (const file of files) {
    const normalizedPath = file.relativePath.replace(/\\/g, "/");
    const parts = normalizedPath.split("/");
    let current = root;

    for (const [index, part] of parts.entries()) {
      if (!current.children.has(part)) {
        current.children.set(part, makeNode());
      }
      current = current.children.get(part) as TreeNode;
      if (index === parts.length - 1) {
        current.isFile = true;
        if (file.description && !isSystemMemoryFile(normalizedPath)) {
          current.description = file.description;
        }
      }
    }
  }

  if (!root.children.has(MEMORY_SYSTEM_DIR)) {
    root.children.set(MEMORY_SYSTEM_DIR, makeNode());
  }

  const sortedEntries = (node: TreeNode) =>
    Array.from(node.children.entries()).sort(
      ([nameA, nodeA], [nameB, nodeB]) => {
        if (nodeA.isFile !== nodeB.isFile) {
          return nodeA.isFile ? 1 : -1;
        }
        return nameA.localeCompare(nameB);
      },
    );

  const limits = getDirectoryLimits();
  const maxLines = Math.max(2, limits.memfsTreeMaxLines);
  const maxChars = Math.max(128, limits.memfsTreeMaxChars);
  const maxChildrenPerDir = Math.max(1, limits.memfsTreeMaxChildrenPerDir);

  const rootLine = "/memory/";
  const lines: string[] = [rootLine];
  let totalChars = rootLine.length;

  const countTreeEntries = (node: TreeNode): number => {
    let total = 0;
    for (const [, child] of node.children) {
      total += 1;
      if (child.children.size > 0) {
        total += countTreeEntries(child);
      }
    }
    return total;
  };

  const canAppendLine = (line: string): boolean => {
    const nextLineCount = lines.length + 1;
    const nextCharCount = totalChars + 1 + line.length;
    return nextLineCount <= maxLines && nextCharCount <= maxChars;
  };

  const render = (node: TreeNode, prefix: string): boolean => {
    const entries = sortedEntries(node);
    const visibleEntries = entries.slice(0, maxChildrenPerDir);
    const omittedEntries = Math.max(0, entries.length - visibleEntries.length);

    const renderItems: Array<
      | { kind: "entry"; name: string; child: TreeNode }
      | { kind: "omitted"; omittedCount: number }
    > = visibleEntries.map(([name, child]) => ({
      kind: "entry",
      name,
      child,
    }));

    if (omittedEntries > 0) {
      renderItems.push({ kind: "omitted", omittedCount: omittedEntries });
    }

    for (const [index, item] of renderItems.entries()) {
      const isLast = index === renderItems.length - 1;
      const branch = isLast ? "└──" : "├──";
      const line =
        item.kind === "entry"
          ? `${prefix}${branch} ${item.name}${item.child.isFile ? "" : "/"}${item.child.description ? ` (${item.child.description})` : ""}`
          : `${prefix}${branch} … (${item.omittedCount.toLocaleString()} more entries)`;

      if (!canAppendLine(line)) {
        return false;
      }

      lines.push(line);
      totalChars += 1 + line.length;

      if (item.kind === "entry" && item.child.children.size > 0) {
        const nextPrefix = `${prefix}${isLast ? "    " : "│   "}`;
        if (!render(item.child, nextPrefix)) {
          return false;
        }
      }
    }

    return true;
  };

  const totalEntries = countTreeEntries(root);
  const fullyRendered = render(root, "");

  if (!fullyRendered) {
    while (lines.length > 1) {
      const shownEntries = Math.max(0, lines.length - 1);
      const omittedEntries = Math.max(1, totalEntries - shownEntries);
      const notice = `[Tree truncated: showing ${shownEntries.toLocaleString()} of ${totalEntries.toLocaleString()} entries. ${omittedEntries.toLocaleString()} omitted.]`;

      if (canAppendLine(notice)) {
        lines.push(notice);
        break;
      }

      const removed = lines.pop();
      if (removed) {
        totalChars -= 1 + removed.length;
      }
    }
  }

  return lines.join("\n");
}

function joinedLength(lines: string[]): number {
  return lines.join("\n").length;
}

function canAppendWithinBudget(
  lines: string[],
  additions: string[],
  maxChars: number,
): boolean {
  return joinedLength([...lines, ...additions, "</parent_memory>"]) <= maxChars;
}

function truncateMemoryContentToFit(
  lines: string[],
  prefix: string[],
  content: string,
  suffix: string[],
  maxChars: number,
): string | null {
  const fixedLength = joinedLength([
    ...lines,
    ...prefix,
    "",
    ...suffix,
    "</parent_memory>",
  ]);
  const budget = maxChars - fixedLength;
  if (budget <= 0) {
    return null;
  }

  return content.slice(0, budget).trimEnd();
}

function buildMemoryPreviewNotice(
  relativePath: string,
  absolutePath: string,
  kind: "truncated" | "omitted",
): string {
  const action = kind === "truncated" ? "truncated" : "omitted";
  return `[Memory preview ${action}: startup context is capped at ~16k estimated tokens. Full file available at ${absolutePath}; read it directly if needed. Relative path: ${relativePath}]`;
}

export async function buildParentMemorySnapshot(
  memoryDir: string,
  options: ParentMemorySnapshotOptions = {},
): Promise<string> {
  if (options.memoryFormat === "memfs-v2") {
    return buildMemfsV2ParentMemorySnapshot(memoryDir, options.maxChars);
  }
  const files = await collectParentMemoryFiles(memoryDir);
  const tree = buildParentMemoryTree(files);
  const systemFiles = files.filter((file) =>
    isSystemMemoryFile(file.relativePath),
  );
  const maxChars = Math.max(
    1_000,
    options.maxChars ?? REFLECTION_PARENT_MEMORY_SNAPSHOT_CHAR_LIMIT,
  );

  const lines = [
    "<parent_memory>",
    "<memory_filesystem>",
    tree,
    "</memory_filesystem>",
  ];

  if (files.length === 0) {
    lines.push("(no memory markdown files found)");
  } else {
    let omittedSystemFiles = 0;

    for (const file of systemFiles) {
      const normalizedPath = file.relativePath.replace(/\\/g, "/");
      const absolutePath = `$MEMORY_DIR/${normalizedPath}`;
      const prefix = ["<memory>", `<path>${absolutePath}</path>`];
      const suffix = ["</memory>"];
      const fullEntry = [...prefix, file.content, ...suffix];

      if (canAppendWithinBudget(lines, fullEntry, maxChars)) {
        lines.push(...fullEntry);
        continue;
      }

      const truncatedNotice = buildMemoryPreviewNotice(
        normalizedPath,
        absolutePath,
        "truncated",
      );
      const truncatedContent = truncateMemoryContentToFit(
        lines,
        prefix,
        file.content,
        [truncatedNotice, ...suffix],
        maxChars,
      );

      if (truncatedContent) {
        const truncatedEntry = [
          ...prefix,
          truncatedContent,
          truncatedNotice,
          ...suffix,
        ];
        if (canAppendWithinBudget(lines, truncatedEntry, maxChars)) {
          lines.push(...truncatedEntry);
          continue;
        }
      }

      const omittedEntry = [
        ...prefix,
        buildMemoryPreviewNotice(normalizedPath, absolutePath, "omitted"),
        ...suffix,
      ];
      if (canAppendWithinBudget(lines, omittedEntry, maxChars)) {
        lines.push(...omittedEntry);
      } else {
        omittedSystemFiles += 1;
      }
    }

    if (omittedSystemFiles > 0) {
      const notice = `[Memory preview omitted ${omittedSystemFiles.toLocaleString()} additional system file(s) because the reflection startup context budget was exhausted. Read files directly from $MEMORY_DIR if needed.]`;
      if (canAppendWithinBudget(lines, [notice], maxChars)) {
        lines.push(notice);
      }
    }
  }

  lines.push("</parent_memory>");
  return lines.join("\n");
}
