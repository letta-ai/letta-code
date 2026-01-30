import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

import type { Block } from "@letta-ai/letta-client/resources/agents/blocks";
import { getClient } from "./client";
import {
  ISOLATED_BLOCK_LABELS,
  parseMdxFrontmatter,
  READ_ONLY_BLOCK_LABELS,
} from "./memory";

export const MEMORY_FILESYSTEM_BLOCK_LABEL = "memory_filesystem";
export const MEMORY_FS_ROOT = ".letta";
export const MEMORY_FS_AGENTS_DIR = "agents";
export const MEMORY_FS_MEMORY_DIR = "memory";
export const MEMORY_SYSTEM_DIR = "system";
/** @deprecated Detached blocks now go at root level, not in /user/ */
export const MEMORY_USER_DIR = "user";
export const MEMORY_FS_STATE_FILE = ".sync-state.json";

/**
 * Block labels that are managed by the system and should be skipped during sync.
 * These blocks are auto-created/managed by the harness (skills, loaded_skills)
 * or by the memfs system itself (memory_filesystem).
 */
const MANAGED_BLOCK_LABELS = new Set([
  MEMORY_FILESYSTEM_BLOCK_LABEL,
  ...ISOLATED_BLOCK_LABELS,
]);

type SyncState = {
  systemBlocks: Record<string, string>;
  systemFiles: Record<string, string>;
  detachedBlocks: Record<string, string>;
  detachedFiles: Record<string, string>;
  detachedBlockIds: Record<string, string>;
  lastSync: string | null;
};

export type MemorySyncConflict = {
  label: string;
  blockValue: string | null;
  fileValue: string | null;
};

export type MemfsSyncStatus = {
  /** Blocks where both file and block changed since last sync */
  conflicts: MemorySyncConflict[];
  /** Labels where only the file changed (would auto-resolve to block) */
  pendingFromFile: string[];
  /** Labels where only the block changed (would auto-resolve to file) */
  pendingFromBlock: string[];
  /** Labels where a file exists but no block */
  newFiles: string[];
  /** Labels where a block exists but no file */
  newBlocks: string[];
  /** True when there are no conflicts or pending changes */
  isClean: boolean;
};

export type MemorySyncResult = {
  updatedBlocks: string[];
  createdBlocks: string[];
  deletedBlocks: string[];
  updatedFiles: string[];
  createdFiles: string[];
  deletedFiles: string[];
  conflicts: MemorySyncConflict[];
};

export type MemorySyncResolution = {
  label: string;
  resolution: "file" | "block";
};

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

/**
 * Get the directory for detached (non-attached) blocks.
 * In the flat structure, detached blocks go directly in the memory root.
 */
export function getMemoryDetachedDir(
  agentId: string,
  homeDir: string = homedir(),
): string {
  // Detached blocks go at root level (flat structure)
  return getMemoryFilesystemRoot(agentId, homeDir);
}

function getMemoryStatePath(
  agentId: string,
  homeDir: string = homedir(),
): string {
  return join(getMemoryFilesystemRoot(agentId, homeDir), MEMORY_FS_STATE_FILE);
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
  // Note: detached blocks go directly in root, no separate directory needed
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function loadSyncState(
  agentId: string,
  homeDir: string = homedir(),
): SyncState {
  const statePath = getMemoryStatePath(agentId, homeDir);
  if (!existsSync(statePath)) {
    return {
      systemBlocks: {},
      systemFiles: {},
      detachedBlocks: {},
      detachedFiles: {},
      detachedBlockIds: {},
      lastSync: null,
    };
  }

  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SyncState> & {
      blocks?: Record<string, string>;
      files?: Record<string, string>;
    };
    return {
      systemBlocks: parsed.systemBlocks || parsed.blocks || {},
      systemFiles: parsed.systemFiles || parsed.files || {},
      detachedBlocks: parsed.detachedBlocks || {},
      detachedFiles: parsed.detachedFiles || {},
      detachedBlockIds: parsed.detachedBlockIds || {},
      lastSync: parsed.lastSync || null,
    };
  } catch {
    return {
      systemBlocks: {},
      systemFiles: {},
      detachedBlocks: {},
      detachedFiles: {},
      detachedBlockIds: {},
      lastSync: null,
    };
  }
}

async function saveSyncState(
  state: SyncState,
  agentId: string,
  homeDir: string = homedir(),
) {
  const statePath = getMemoryStatePath(agentId, homeDir);
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

async function scanMdFiles(
  dir: string,
  baseDir = dir,
  excludeDirs: string[] = [],
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip excluded directories (e.g., "system" when scanning for detached files)
      if (excludeDirs.includes(entry.name)) {
        continue;
      }
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

/**
 * Parse file content and extract block creation data.
 * Handles YAML frontmatter for label, description, limit, and read_only.
 */
export function parseBlockFromFileContent(
  fileContent: string,
  defaultLabel: string,
): {
  label: string;
  value: string;
  description: string;
  limit: number;
  read_only?: boolean;
} {
  const { frontmatter, body } = parseMdxFrontmatter(fileContent);

  // Use frontmatter label if provided, otherwise use default (from file path)
  const label = frontmatter.label || defaultLabel;

  // Use frontmatter description if provided, otherwise generate from label
  const description = frontmatter.description || `Memory block: ${label}`;

  // Use frontmatter limit if provided and valid, otherwise default to 20000
  let limit = 20000;
  if (frontmatter.limit) {
    const parsed = Number.parseInt(frontmatter.limit, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      limit = parsed;
    }
  }

  // Check if block should be read-only (from frontmatter or known read-only labels)
  const isReadOnly =
    frontmatter.read_only === "true" ||
    (READ_ONLY_BLOCK_LABELS as readonly string[]).includes(label);

  return {
    label,
    value: body,
    description,
    limit,
    ...(isReadOnly && { read_only: true }),
  };
}

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

async function ensureFilePath(filePath: string) {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

async function writeMemoryFile(dir: string, label: string, content: string) {
  const filePath = join(dir, `${label}.md`);
  await ensureFilePath(filePath);
  await writeFile(filePath, content, "utf-8");
}

async function deleteMemoryFile(dir: string, label: string) {
  const filePath = join(dir, `${label}.md`);
  if (existsSync(filePath)) {
    await unlink(filePath);
  }
}

async function fetchAgentBlocks(agentId: string): Promise<Block[]> {
  const client = await getClient();
  // Use high limit - SDK's async iterator has a bug that causes infinite loops
  const page = await client.agents.blocks.list(agentId, { limit: 1000 });

  // Handle both array response and paginated response
  if (Array.isArray(page)) {
    return page;
  }

  // Extract items from paginated response
  const items =
    (page as { items?: Block[] }).items ||
    (page as { blocks?: Block[] }).blocks ||
    [];
  return items;
}

/**
 * Fetch all blocks owned by this agent (via owner tag).
 * This includes both attached and detached blocks.
 */
async function fetchOwnedBlocks(agentId: string): Promise<Block[]> {
  const client = await getClient();
  const ownerTag = `owner:${agentId}`;
  const page = await client.blocks.list({ tags: [ownerTag], limit: 1000 });

  // Handle both array response and paginated response
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
 * Backfill owner tags on blocks that don't have them.
 * This ensures backwards compatibility with blocks created before tagging.
 */
async function backfillOwnerTags(
  agentId: string,
  blocks: Block[],
): Promise<void> {
  const client = await getClient();
  const ownerTag = `owner:${agentId}`;

  for (const block of blocks) {
    if (!block.id) continue;
    const tags = block.tags || [];
    if (!tags.includes(ownerTag)) {
      await client.blocks.update(block.id, {
        tags: [...tags, ownerTag],
      });
    }
  }
}

export function renderMemoryFilesystemTree(
  systemLabels: string[],
  detachedLabels: string[],
): string {
  type TreeNode = { children: Map<string, TreeNode>; isFile: boolean };

  const makeNode = (): TreeNode => ({ children: new Map(), isFile: false });
  const root = makeNode();

  const insertPath = (base: string | null, label: string) => {
    // If base is null, insert at root level
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

  // System blocks go in /system/
  for (const label of systemLabels) {
    insertPath(MEMORY_SYSTEM_DIR, label);
  }
  // Detached blocks go at root level (flat structure)
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

function buildStateHashes(
  systemBlocks: Map<string, { value: string }>,
  systemFiles: Map<string, { content: string }>,
  detachedBlocks: Map<string, { value: string }>,
  detachedFiles: Map<string, { content: string }>,
  detachedBlockIds: Record<string, string>,
): SyncState {
  const systemBlockHashes: Record<string, string> = {};
  const systemFileHashes: Record<string, string> = {};
  const userBlockHashes: Record<string, string> = {};
  const userFileHashes: Record<string, string> = {};

  systemBlocks.forEach((block, label) => {
    systemBlockHashes[label] = hashContent(block.value || "");
  });

  systemFiles.forEach((file, label) => {
    systemFileHashes[label] = hashContent(file.content || "");
  });

  detachedBlocks.forEach((block, label) => {
    userBlockHashes[label] = hashContent(block.value || "");
  });

  detachedFiles.forEach((file, label) => {
    userFileHashes[label] = hashContent(file.content || "");
  });

  return {
    systemBlocks: systemBlockHashes,
    systemFiles: systemFileHashes,
    detachedBlocks: userBlockHashes,
    detachedFiles: userFileHashes,
    detachedBlockIds,
    lastSync: new Date().toISOString(),
  };
}

export async function syncMemoryFilesystem(
  agentId: string,
  options: { homeDir?: string; resolutions?: MemorySyncResolution[] } = {},
): Promise<MemorySyncResult> {
  const homeDir = options.homeDir ?? homedir();
  ensureMemoryFilesystemDirs(agentId, homeDir);

  const systemDir = getMemorySystemDir(agentId, homeDir);
  const detachedDir = getMemoryDetachedDir(agentId, homeDir);
  const systemFiles = await readMemoryFiles(systemDir);
  const detachedFiles = await readMemoryFiles(detachedDir, [MEMORY_SYSTEM_DIR]);
  systemFiles.delete(MEMORY_FILESYSTEM_BLOCK_LABEL);

  const attachedBlocks = await fetchAgentBlocks(agentId);
  const systemBlockMap = new Map(
    attachedBlocks
      .filter((block) => block.label)
      .map((block) => [block.label as string, block]),
  );
  systemBlockMap.delete(MEMORY_FILESYSTEM_BLOCK_LABEL);

  const lastState = loadSyncState(agentId, homeDir);
  const conflicts: MemorySyncConflict[] = [];

  const updatedBlocks: string[] = [];
  const createdBlocks: string[] = [];
  const deletedBlocks: string[] = [];
  const updatedFiles: string[] = [];
  const createdFiles: string[] = [];
  const deletedFiles: string[] = [];

  const resolutions = new Map(
    (options.resolutions ?? []).map((resolution) => [
      resolution.label,
      resolution,
    ]),
  );

  const client = await getClient();

  // Backfill owner tags on attached blocks (for backwards compat)
  await backfillOwnerTags(agentId, attachedBlocks);

  // Discover detached blocks via owner tag (replaces detachedBlockIds tracking)
  const allOwnedBlocks = await fetchOwnedBlocks(agentId);
  const attachedIds = new Set(attachedBlocks.map((b) => b.id));
  const detachedBlocks = allOwnedBlocks.filter((b) => !attachedIds.has(b.id));

  // Build detached block map and IDs (for sync state compatibility)
  const detachedBlockIds: Record<string, string> = {};
  const detachedBlockMap = new Map<string, Block>();
  for (const block of detachedBlocks) {
    if (block.label && block.id) {
      // Skip managed blocks (skills, loaded_skills, memory_filesystem)
      if (MANAGED_BLOCK_LABELS.has(block.label)) {
        continue;
      }
      detachedBlockIds[block.label] = block.id;
      detachedBlockMap.set(block.label, block);
    }
  }

  const systemLabels = new Set<string>([
    ...Array.from(systemFiles.keys()),
    ...Array.from(systemBlockMap.keys()),
    ...Object.keys(lastState.systemBlocks),
    ...Object.keys(lastState.systemFiles),
  ]);

  for (const label of Array.from(systemLabels).sort()) {
    if (MANAGED_BLOCK_LABELS.has(label)) {
      continue;
    }

    const fileEntry = systemFiles.get(label);
    const blockEntry = systemBlockMap.get(label);

    const fileHash = fileEntry ? hashContent(fileEntry.content) : null;
    const blockHash = blockEntry ? hashContent(blockEntry.value || "") : null;

    const lastFileHash = lastState.systemFiles[label] || null;
    const lastBlockHash = lastState.systemBlocks[label] || null;

    const fileChanged = fileHash !== lastFileHash;
    const blockChanged = blockHash !== lastBlockHash;

    const resolution = resolutions.get(label);

    if (fileEntry && !blockEntry) {
      if (lastBlockHash && !fileChanged) {
        // Block was deleted elsewhere; delete file.
        await deleteMemoryFile(systemDir, label);
        deletedFiles.push(label);
        continue;
      }

      // Create block from file (parsing frontmatter for description/limit)
      const blockData = parseBlockFromFileContent(fileEntry.content, label);
      const createdBlock = await client.blocks.create({
        ...blockData,
        tags: [`owner:${agentId}`],
      });
      if (createdBlock.id) {
        await client.agents.blocks.attach(createdBlock.id, {
          agent_id: agentId,
        });
      }
      createdBlocks.push(blockData.label);
      continue;
    }

    if (!fileEntry && blockEntry) {
      if (lastFileHash && !blockChanged) {
        // File deleted, block unchanged -> detach only (block stays with owner tag)
        if (blockEntry.id) {
          try {
            await client.agents.blocks.detach(blockEntry.id, {
              agent_id: agentId,
            });
            // Note: Don't delete the block - it keeps its owner tag for potential recovery
            deletedBlocks.push(label);
          } catch (err) {
            // Block may have been manually deleted already - ignore
            if (!(err instanceof Error && err.message.includes("Not Found"))) {
              throw err;
            }
          }
        }
        continue;
      }

      // Create file from block
      await writeMemoryFile(systemDir, label, blockEntry.value || "");
      createdFiles.push(label);
      continue;
    }

    if (!fileEntry || !blockEntry) {
      continue;
    }

    // If file and block have the same content, they're in sync - no conflict
    if (fileHash === blockHash) {
      continue;
    }

    if (fileChanged && blockChanged && !resolution) {
      conflicts.push({
        label,
        blockValue: blockEntry.value || "",
        fileValue: fileEntry.content,
      });
      continue;
    }

    if (resolution?.resolution === "file") {
      if (blockEntry.id) {
        await client.blocks.update(blockEntry.id, {
          value: fileEntry.content,
        });
        updatedBlocks.push(label);
      }
      continue;
    }

    if (resolution?.resolution === "block") {
      await writeMemoryFile(systemDir, label, blockEntry.value || "");
      updatedFiles.push(label);
      continue;
    }

    if (fileChanged && !blockChanged) {
      if (blockEntry.id) {
        try {
          await client.blocks.update(blockEntry.id, {
            value: fileEntry.content,
          });
          updatedBlocks.push(label);
        } catch (err) {
          // Block may have been deleted - create a new one
          if (err instanceof Error && err.message.includes("Not Found")) {
            const blockData = parseBlockFromFileContent(
              fileEntry.content,
              label,
            );
            const createdBlock = await client.blocks.create({
              ...blockData,
              tags: [`owner:${agentId}`],
            });
            if (createdBlock.id) {
              await client.agents.blocks.attach(createdBlock.id, {
                agent_id: agentId,
              });
            }
            createdBlocks.push(blockData.label);
          } else {
            throw err;
          }
        }
      }
      continue;
    }

    if (!fileChanged && blockChanged) {
      await writeMemoryFile(systemDir, label, blockEntry.value || "");
      updatedFiles.push(label);
    }
  }

  const detachedLabels = new Set<string>([
    ...Array.from(detachedFiles.keys()),
    ...Array.from(detachedBlockMap.keys()),
    ...Object.keys(lastState.detachedBlocks),
    ...Object.keys(lastState.detachedFiles),
  ]);

  for (const label of Array.from(detachedLabels).sort()) {
    const fileEntry = detachedFiles.get(label);
    const blockEntry = detachedBlockMap.get(label);

    const fileHash = fileEntry ? hashContent(fileEntry.content) : null;
    const blockHash = blockEntry ? hashContent(blockEntry.value || "") : null;

    const lastFileHash = lastState.detachedFiles[label] || null;
    const lastBlockHash = lastState.detachedBlocks[label] || null;

    const fileChanged = fileHash !== lastFileHash;
    const blockChanged = blockHash !== lastBlockHash;

    const resolution = resolutions.get(label);

    if (fileEntry && !blockEntry) {
      if (lastBlockHash && !fileChanged) {
        // Block was deleted elsewhere; delete file.
        await deleteMemoryFile(detachedDir, label);
        deletedFiles.push(label);
        delete detachedBlockIds[label];
        continue;
      }

      const blockData = parseBlockFromFileContent(fileEntry.content, label);
      const createdBlock = await client.blocks.create({
        ...blockData,
        tags: [`owner:${agentId}`],
      });
      if (createdBlock.id) {
        detachedBlockIds[blockData.label] = createdBlock.id;
        detachedBlockMap.set(blockData.label, createdBlock as Block);
      }
      createdBlocks.push(blockData.label);
      continue;
    }

    if (!fileEntry && blockEntry) {
      if (lastFileHash && !blockChanged) {
        // File deleted, block unchanged -> just remove from tracking (block keeps owner tag)
        // Note: Don't delete the block - it stays discoverable via owner tag
        deletedBlocks.push(label);
        delete detachedBlockIds[label];
        continue;
      }

      await writeMemoryFile(detachedDir, label, blockEntry.value || "");
      createdFiles.push(label);
      continue;
    }

    if (!fileEntry || !blockEntry) {
      continue;
    }

    // If file and block have the same content, they're in sync - no conflict
    if (fileHash === blockHash) {
      continue;
    }

    if (fileChanged && blockChanged && !resolution) {
      conflicts.push({
        label,
        blockValue: blockEntry.value || "",
        fileValue: fileEntry.content,
      });
      continue;
    }

    if (resolution?.resolution === "file") {
      if (blockEntry.id) {
        await client.blocks.update(blockEntry.id, {
          value: fileEntry.content,
          label,
        });
      }
      updatedBlocks.push(label);
      continue;
    }

    if (resolution?.resolution === "block") {
      await writeMemoryFile(detachedDir, label, blockEntry.value || "");
      updatedFiles.push(label);
      continue;
    }

    if (fileChanged && !blockChanged) {
      if (blockEntry.id) {
        await client.blocks.update(blockEntry.id, {
          value: fileEntry.content,
          label,
        });
      }
      updatedBlocks.push(label);
      continue;
    }

    if (!fileChanged && blockChanged) {
      await writeMemoryFile(detachedDir, label, blockEntry.value || "");
      updatedFiles.push(label);
    }
  }

  if (conflicts.length === 0) {
    const updatedBlocksList = await fetchAgentBlocks(agentId);
    const updatedSystemBlockMap = new Map(
      updatedBlocksList
        .filter(
          (block) =>
            block.label && block.label !== MEMORY_FILESYSTEM_BLOCK_LABEL,
        )
        .map((block) => [block.label as string, { value: block.value || "" }]),
    );

    const updatedSystemFilesMap = await readMemoryFiles(systemDir);
    updatedSystemFilesMap.delete(MEMORY_FILESYSTEM_BLOCK_LABEL);
    const updatedUserFilesMap = await readMemoryFiles(detachedDir, [
      MEMORY_SYSTEM_DIR,
    ]);
    const refreshedUserBlocks = new Map<string, { value: string }>();

    for (const [label, blockId] of Object.entries(detachedBlockIds)) {
      try {
        const block = await client.blocks.retrieve(blockId);
        refreshedUserBlocks.set(label, { value: block.value || "" });
      } catch {
        delete detachedBlockIds[label];
      }
    }

    const nextState = buildStateHashes(
      updatedSystemBlockMap,
      updatedSystemFilesMap,
      refreshedUserBlocks,
      updatedUserFilesMap,
      detachedBlockIds,
    );
    await saveSyncState(nextState, agentId, homeDir);
  }

  return {
    updatedBlocks,
    createdBlocks,
    deletedBlocks,
    updatedFiles,
    createdFiles,
    deletedFiles,
    conflicts,
  };
}

export async function updateMemoryFilesystemBlock(
  agentId: string,
  homeDir: string = homedir(),
) {
  const systemDir = getMemorySystemDir(agentId, homeDir);
  const detachedDir = getMemoryDetachedDir(agentId, homeDir);

  const systemFiles = await readMemoryFiles(systemDir);
  const detachedFiles = await readMemoryFiles(detachedDir, [MEMORY_SYSTEM_DIR]);

  const tree = renderMemoryFilesystemTree(
    Array.from(systemFiles.keys()).filter(
      (label) => label !== MEMORY_FILESYSTEM_BLOCK_LABEL,
    ),
    Array.from(detachedFiles.keys()),
  );

  const client = await getClient();
  const blocks = await fetchAgentBlocks(agentId);
  const memfsBlock = blocks.find(
    (block) => block.label === MEMORY_FILESYSTEM_BLOCK_LABEL,
  );

  if (memfsBlock?.id) {
    await client.blocks.update(memfsBlock.id, { value: tree });
  }

  await writeMemoryFile(systemDir, MEMORY_FILESYSTEM_BLOCK_LABEL, tree);
}

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

export async function refreshMemoryFilesystemTree(
  agentId: string,
  homeDir: string = homedir(),
) {
  ensureMemoryFilesystemDirs(agentId, homeDir);
  await updateMemoryFilesystemBlock(agentId, homeDir);
}

export async function collectMemorySyncConflicts(
  agentId: string,
  homeDir: string = homedir(),
): Promise<MemorySyncConflict[]> {
  const result = await syncMemoryFilesystem(agentId, { homeDir });
  return result.conflicts;
}

export function formatMemorySyncSummary(result: MemorySyncResult): string {
  const lines: string[] = [];
  const pushCount = (label: string, count: number) => {
    if (count > 0) {
      lines.push(`⎿  ${label}: ${count}`);
    }
  };

  pushCount("Blocks updated", result.updatedBlocks.length);
  pushCount("Blocks created", result.createdBlocks.length);
  pushCount("Blocks deleted", result.deletedBlocks.length);
  pushCount("Files updated", result.updatedFiles.length);
  pushCount("Files created", result.createdFiles.length);
  pushCount("Files deleted", result.deletedFiles.length);

  if (result.conflicts.length > 0) {
    lines.push(`⎿  Conflicts: ${result.conflicts.length}`);
  }

  if (lines.length === 0) {
    return "Memory filesystem sync complete (no changes needed)";
  }

  return `Memory filesystem sync complete:\n${lines.join("\n")}`;
}

/**
 * Read-only check of the current memFS sync status.
 * Does NOT modify any blocks, files, or sync state.
 * Safe to call frequently (e.g., after every turn).
 */
export async function checkMemoryFilesystemStatus(
  agentId: string,
  options?: { homeDir?: string },
): Promise<MemfsSyncStatus> {
  const homeDir = options?.homeDir ?? homedir();
  ensureMemoryFilesystemDirs(agentId, homeDir);

  const systemDir = getMemorySystemDir(agentId, homeDir);
  const detachedDir = getMemoryDetachedDir(agentId, homeDir);
  const systemFiles = await readMemoryFiles(systemDir);
  const detachedFiles = await readMemoryFiles(detachedDir, [MEMORY_SYSTEM_DIR]);
  systemFiles.delete(MEMORY_FILESYSTEM_BLOCK_LABEL);

  const attachedBlocks = await fetchAgentBlocks(agentId);
  const systemBlockMap = new Map(
    attachedBlocks
      .filter((block) => block.label)
      .map((block) => [block.label as string, block]),
  );
  systemBlockMap.delete(MEMORY_FILESYSTEM_BLOCK_LABEL);

  const lastState = loadSyncState(agentId, homeDir);

  const conflicts: MemorySyncConflict[] = [];
  const pendingFromFile: string[] = [];
  const pendingFromBlock: string[] = [];
  const newFiles: string[] = [];
  const newBlocks: string[] = [];

  // Discover detached blocks via owner tag
  const allOwnedBlocks = await fetchOwnedBlocks(agentId);
  const attachedIds = new Set(attachedBlocks.map((b) => b.id));
  const detachedBlocks = allOwnedBlocks.filter((b) => !attachedIds.has(b.id));

  const detachedBlockMap = new Map<string, Block>();
  for (const block of detachedBlocks) {
    if (block.label) {
      // Skip managed blocks
      if (MANAGED_BLOCK_LABELS.has(block.label)) {
        continue;
      }
      detachedBlockMap.set(block.label, block);
    }
  }

  // Check system labels
  const systemLabels = new Set<string>([
    ...Array.from(systemFiles.keys()),
    ...Array.from(systemBlockMap.keys()),
    ...Object.keys(lastState.systemBlocks),
    ...Object.keys(lastState.systemFiles),
  ]);

  for (const label of Array.from(systemLabels).sort()) {
    if (MANAGED_BLOCK_LABELS.has(label)) continue;
    classifyLabel(
      label,
      systemFiles.get(label)?.content ?? null,
      systemBlockMap.get(label)?.value ?? null,
      lastState.systemFiles[label] ?? null,
      lastState.systemBlocks[label] ?? null,
      conflicts,
      pendingFromFile,
      pendingFromBlock,
      newFiles,
      newBlocks,
    );
  }

  // Check user labels
  const detachedLabels = new Set<string>([
    ...Array.from(detachedFiles.keys()),
    ...Array.from(detachedBlockMap.keys()),
    ...Object.keys(lastState.detachedBlocks),
    ...Object.keys(lastState.detachedFiles),
  ]);

  for (const label of Array.from(detachedLabels).sort()) {
    classifyLabel(
      label,
      detachedFiles.get(label)?.content ?? null,
      detachedBlockMap.get(label)?.value ?? null,
      lastState.detachedFiles[label] ?? null,
      lastState.detachedBlocks[label] ?? null,
      conflicts,
      pendingFromFile,
      pendingFromBlock,
      newFiles,
      newBlocks,
    );
  }

  const isClean =
    conflicts.length === 0 &&
    pendingFromFile.length === 0 &&
    pendingFromBlock.length === 0 &&
    newFiles.length === 0 &&
    newBlocks.length === 0;

  return {
    conflicts,
    pendingFromFile,
    pendingFromBlock,
    newFiles,
    newBlocks,
    isClean,
  };
}

/**
 * Classify a single label's sync status (read-only).
 * Pushes into the appropriate output array based on file/block state comparison.
 */
function classifyLabel(
  label: string,
  fileContent: string | null,
  blockValue: string | null,
  lastFileHash: string | null,
  lastBlockHash: string | null,
  conflicts: MemorySyncConflict[],
  pendingFromFile: string[],
  pendingFromBlock: string[],
  newFiles: string[],
  newBlocks: string[],
): void {
  const fileHash = fileContent !== null ? hashContent(fileContent) : null;
  const blockHash = blockValue !== null ? hashContent(blockValue) : null;

  const fileChanged = fileHash !== lastFileHash;
  const blockChanged = blockHash !== lastBlockHash;

  if (fileContent !== null && blockValue === null) {
    if (lastBlockHash && !fileChanged) {
      // Block was deleted, file unchanged — would delete file
      return;
    }
    newFiles.push(label);
    return;
  }

  if (fileContent === null && blockValue !== null) {
    if (lastFileHash && !blockChanged) {
      // File was deleted, block unchanged — would delete block
      return;
    }
    newBlocks.push(label);
    return;
  }

  if (fileContent === null || blockValue === null) {
    return;
  }

  // Both exist — check for differences
  if (fileHash === blockHash) {
    return; // In sync
  }

  if (fileChanged && blockChanged) {
    conflicts.push({ label, blockValue, fileValue: fileContent });
    return;
  }

  if (fileChanged && !blockChanged) {
    pendingFromFile.push(label);
    return;
  }

  if (!fileChanged && blockChanged) {
    pendingFromBlock.push(label);
  }
}

/**
 * Detach the memory_filesystem block from an agent.
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
