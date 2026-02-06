/**
 * Memory filesystem helpers.
 *
 * With git-backed memory, most sync/hash logic is removed.
 * This module retains: directory helpers, tree rendering,
 * and the memory_filesystem block update.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import type { Block } from "@letta-ai/letta-client/resources/agents/blocks";
import { getClient } from "./client";

export const MEMORY_FILESYSTEM_BLOCK_LABEL = "memory_filesystem";
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

// ----- File scanning -----

/** Recursively find all .md files in a directory, returning relative paths. */
async function scanMdFiles(
  dir: string,
  baseDir = dir,
  excludeDirs: string[] = [],
): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirs.includes(entry.name)) continue;
      results.push(...(await scanMdFiles(fullPath, baseDir, excludeDirs)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(relative(baseDir, fullPath));
    }
  }

  return results;
}

export function labelFromRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.replace(/\.md$/, "");
}

/** Read all .md files in a directory, returning a map of label → content. */
async function readMemoryFiles(
  dir: string,
  excludeDirs: string[] = [],
): Promise<Map<string, { content: string; path: string }>> {
  const files = await scanMdFiles(dir, dir, excludeDirs);
  const entries = new Map<string, { content: string; path: string }>();

  for (const relativePath of files) {
    const label = labelFromRelativePath(relativePath);
    const fullPath = join(dir, relativePath);
    const content = await readFile(fullPath, "utf-8");
    entries.set(label, { content, path: fullPath });
  }

  return entries;
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

// ----- Block helpers -----

async function fetchAgentBlocks(agentId: string): Promise<Block[]> {
  const client = await getClient();
  const page = await client.agents.blocks.list(agentId, { limit: 1000 });

  if (Array.isArray(page)) {
    return page;
  }

  const items =
    (page as { items?: Block[] }).items ||
    (page as { blocks?: Block[] }).blocks ||
    [];
  return items;
}

/**
 * Update the memory_filesystem block with the current tree visualization.
 */
export async function updateMemoryFilesystemBlock(
  agentId: string,
  homeDir: string = homedir(),
) {
  const systemDir = getMemorySystemDir(agentId, homeDir);
  const detachedDir = getMemoryFilesystemRoot(agentId, homeDir);

  const systemFiles = await readMemoryFiles(systemDir);
  const detachedFiles = await readMemoryFiles(detachedDir, [MEMORY_SYSTEM_DIR]);

  const tree = renderMemoryFilesystemTree(
    Array.from(systemFiles.keys()).filter(
      (label) => label !== MEMORY_FILESYSTEM_BLOCK_LABEL,
    ),
    Array.from(detachedFiles.keys()),
  );

  const memoryPath = `~/.letta/agents/${agentId}/memory`;
  const content = `Memory Directory: ${memoryPath}\n\n${tree}`;

  const client = await getClient();
  const blocks = await fetchAgentBlocks(agentId);
  const memfsBlock = blocks.find(
    (block) => block.label === MEMORY_FILESYSTEM_BLOCK_LABEL,
  );

  if (memfsBlock?.id) {
    await client.blocks.update(memfsBlock.id, { value: content });
  }
}

/**
 * Ensure the memory_filesystem block exists for this agent.
 */
export async function ensureMemoryFilesystemBlock(agentId: string) {
  const client = await getClient();
  const blocks = await fetchAgentBlocks(agentId);
  const exists = blocks.some(
    (block) => block.label === MEMORY_FILESYSTEM_BLOCK_LABEL,
  );

  if (exists) {
    return;
  }

  const createdBlock = await client.blocks.create({
    label: MEMORY_FILESYSTEM_BLOCK_LABEL,
    value: "/memory/",
    description: "Filesystem view of memory blocks",
    limit: 20000,
    read_only: true,
    tags: [`owner:${agentId}`],
  });

  if (createdBlock.id) {
    await client.agents.blocks.attach(createdBlock.id, { agent_id: agentId });
  }
}

/**
 * Detach the memory_filesystem block from the agent.
 * Used when disabling memfs.
 */
export async function detachMemoryFilesystemBlock(
  agentId: string,
): Promise<void> {
  const client = await getClient();
  const blocks = await fetchAgentBlocks(agentId);
  const memfsBlock = blocks.find(
    (block) => block.label === MEMORY_FILESYSTEM_BLOCK_LABEL,
  );

  if (memfsBlock?.id) {
    await client.agents.blocks.detach(memfsBlock.id, { agent_id: agentId });
  }
}
