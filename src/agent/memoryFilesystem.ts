import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

import type { Block } from "@letta-ai/letta-client/resources/agents/blocks";
import { getClient } from "./client";
import { parseMdxFrontmatter, READ_ONLY_BLOCK_LABELS } from "./memory";

export const MEMORY_FILESYSTEM_BLOCK_LABEL = "memory_filesystem";
export const MEMORY_FS_ROOT = ".letta";
export const MEMORY_FS_AGENTS_DIR = "agents";
export const MEMORY_FS_MEMORY_DIR = "memory";
export const MEMORY_SYSTEM_DIR = "system";
/** @deprecated Detached blocks now go at root level, not in /user/ */
export const MEMORY_USER_DIR = "user";
export const MEMORY_FS_STATE_FILE = ".sync-state.json";

/**
 * Block labels that are managed by the memfs system itself and have special
 * update logic (updateMemoryFilesystemBlock). These are skipped in the main
 * sync loop but written separately.
 */
const MEMFS_MANAGED_LABELS = new Set([MEMORY_FILESYSTEM_BLOCK_LABEL]);

// Note: skills and loaded_skills (ISOLATED_BLOCK_LABELS) are now synced
// but are read_only in the API, so file edits are ignored (API → file only)

// Unified sync state - no system/detached split
// The attached/detached distinction is derived at runtime from API and FS
type SyncState = {
  blockHashes: Record<string, string>; // label → content hash
  fileHashes: Record<string, string>; // label → content hash
  blockIds: Record<string, string>; // label → block ID
  lastSync: string | null;
};

// Legacy format for migration
type LegacySyncState = {
  systemBlocks?: Record<string, string>;
  systemFiles?: Record<string, string>;
  detachedBlocks?: Record<string, string>;
  detachedFiles?: Record<string, string>;
  detachedBlockIds?: Record<string, string>;
  blocks?: Record<string, string>;
  files?: Record<string, string>;
  lastSync?: string | null;
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
  /** Labels where file location doesn't match block attachment (would auto-sync) */
  locationMismatches: string[];
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

/**
 * Hash just the body content of a file (excluding frontmatter).
 * Used for "content matches" checks where we compare file body to block value.
 */
function hashFileBody(content: string): string {
  const { body } = parseMdxFrontmatter(content);
  return hashContent(body);
}

function loadSyncState(
  agentId: string,
  homeDir: string = homedir(),
): SyncState {
  const statePath = getMemoryStatePath(agentId, homeDir);
  const emptyState: SyncState = {
    blockHashes: {},
    fileHashes: {},
    blockIds: {},
    lastSync: null,
  };

  if (!existsSync(statePath)) {
    return emptyState;
  }

  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as LegacySyncState & Partial<SyncState>;

    // New format - return directly
    if (parsed.blockHashes !== undefined) {
      return {
        blockHashes: parsed.blockHashes || {},
        fileHashes: parsed.fileHashes || {},
        blockIds: parsed.blockIds || {},
        lastSync: parsed.lastSync || null,
      };
    }

    // Migrate from legacy format: merge system + detached into unified maps
    const blockHashes: Record<string, string> = {
      ...(parsed.systemBlocks || parsed.blocks || {}),
      ...(parsed.detachedBlocks || {}),
    };
    const fileHashes: Record<string, string> = {
      ...(parsed.systemFiles || parsed.files || {}),
      ...(parsed.detachedFiles || {}),
    };
    const blockIds: Record<string, string> = {
      ...(parsed.detachedBlockIds || {}),
    };

    return {
      blockHashes,
      fileHashes,
      blockIds,
      lastSync: parsed.lastSync || null,
    };
  } catch {
    return emptyState;
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

/**
 * Serialize a block to file content with YAML frontmatter.
 * Includes description, limit, and read_only (if true) for round-trip preservation.
 * Label is omitted since it's implied by the file path.
 */
export function renderBlockToFileContent(block: {
  value?: string | null;
  description?: string | null;
  limit?: number | null;
  read_only?: boolean | null;
}): string {
  const lines: string[] = ["---"];

  // Always include description (so it round-trips and doesn't silently reset)
  if (block.description) {
    // Escape description for YAML if it contains special chars
    const desc =
      block.description.includes(":") || block.description.includes("\n")
        ? `"${block.description.replace(/"/g, '\\"')}"`
        : block.description;
    lines.push(`description: ${desc}`);
  }

  // Always include limit
  if (block.limit) {
    lines.push(`limit: ${block.limit}`);
  }

  // Only include read_only if true (avoid cluttering frontmatter)
  if (block.read_only === true) {
    lines.push("read_only: true");
  }

  lines.push("---");
  lines.push(""); // blank line after frontmatter
  lines.push(block.value || "");

  return lines.join("\n");
}

/**
 * Parse file content for UPDATING an existing block.
 * Only includes metadata fields that are explicitly present in frontmatter.
 * This prevents overwriting existing API metadata when frontmatter is absent.
 */
export function parseBlockUpdateFromFileContent(
  fileContent: string,
  defaultLabel: string,
): {
  label: string;
  value: string;
  description?: string;
  limit?: number;
  read_only?: boolean;
  // Flags indicating which fields were explicitly present
  hasDescription: boolean;
  hasLimit: boolean;
  hasReadOnly: boolean;
} {
  const { frontmatter, body } = parseMdxFrontmatter(fileContent);

  const label = frontmatter.label || defaultLabel;

  // Check explicit presence using hasOwnProperty
  const hasDescription = Object.hasOwn(frontmatter, "description");
  const hasLimit = Object.hasOwn(frontmatter, "limit");
  const hasReadOnly = Object.hasOwn(frontmatter, "read_only");

  let limit: number | undefined;
  if (hasLimit && frontmatter.limit) {
    const parsed = Number.parseInt(frontmatter.limit, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      limit = parsed;
    }
  }

  return {
    label,
    value: body,
    ...(hasDescription && { description: frontmatter.description }),
    ...(hasLimit && limit !== undefined && { limit }),
    ...(hasReadOnly && { read_only: frontmatter.read_only === "true" }),
    hasDescription,
    hasLimit,
    hasReadOnly,
  };
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
  allBlocks: Map<string, { value?: string | null; id?: string }>,
  allFiles: Map<string, { content: string }>,
): SyncState {
  const blockHashes: Record<string, string> = {};
  const fileHashes: Record<string, string> = {};
  const blockIds: Record<string, string> = {};

  allBlocks.forEach((block, label) => {
    blockHashes[label] = hashContent(block.value || "");
    if (block.id) {
      blockIds[label] = block.id;
    }
  });

  allFiles.forEach((file, label) => {
    fileHashes[label] = hashContent(file.content || "");
  });

  return {
    blockHashes,
    fileHashes,
    blockIds,
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

  // Discover detached blocks via owner tag
  const allOwnedBlocks = await fetchOwnedBlocks(agentId);
  const attachedIds = new Set(attachedBlocks.map((b) => b.id));
  const detachedBlocks = allOwnedBlocks.filter((b) => !attachedIds.has(b.id));

  // Build detached block map
  const detachedBlockMap = new Map<string, Block>();
  for (const block of detachedBlocks) {
    if (block.label && block.id) {
      // Skip memfs-managed blocks (memory_filesystem has special handling)
      if (MEMFS_MANAGED_LABELS.has(block.label)) {
        continue;
      }
      // Skip blocks whose label matches a system block (prevents duplicates)
      // This can happen when a system block is detached but keeps its owner tag
      if (systemBlockMap.has(block.label)) {
        continue;
      }
      detachedBlockMap.set(block.label, block);
    }
  }

  // Unified sync loop - collect all labels and process once
  // The attached/detached distinction is determined at runtime
  const allLabels = new Set<string>([
    ...Array.from(systemFiles.keys()),
    ...Array.from(detachedFiles.keys()),
    ...Array.from(systemBlockMap.keys()),
    ...Array.from(detachedBlockMap.keys()),
    ...Object.keys(lastState.blockHashes),
    ...Object.keys(lastState.fileHashes),
  ]);

  // Track all blocks for state saving
  const allBlocksMap = new Map<
    string,
    { value?: string | null; id?: string }
  >();
  const allFilesMap = new Map<string, { content: string }>();

  for (const label of Array.from(allLabels).sort()) {
    // Skip memfs-managed blocks (memory_filesystem has special handling)
    if (MEMFS_MANAGED_LABELS.has(label)) {
      continue;
    }

    // Determine current state at runtime
    const systemFile = systemFiles.get(label);
    const detachedFile = detachedFiles.get(label);
    const attachedBlock = systemBlockMap.get(label);
    const detachedBlock = detachedBlockMap.get(label);

    // Derive file and block entries
    const fileEntry = systemFile || detachedFile;
    const fileInSystem = !!systemFile;
    const blockEntry = attachedBlock || detachedBlock;
    const isAttached = !!attachedBlock;

    // Get directory for file operations
    const fileDir = fileInSystem ? systemDir : detachedDir;

    const fileHash = fileEntry ? hashContent(fileEntry.content) : null;
    // Body hash excludes frontmatter - used for "content matches" checks
    const fileBodyHash = fileEntry ? hashFileBody(fileEntry.content) : null;
    const blockHash = blockEntry ? hashContent(blockEntry.value || "") : null;

    // Use unified hash lookup
    const lastFileHash = lastState.fileHashes[label] || null;
    const lastBlockHash = lastState.blockHashes[label] || null;

    const fileChanged = fileHash !== lastFileHash;
    const blockChanged = blockHash !== lastBlockHash;

    const resolution = resolutions.get(label);

    // Track for state saving
    if (blockEntry) {
      allBlocksMap.set(label, { value: blockEntry.value, id: blockEntry.id });
    }
    if (fileEntry) {
      allFilesMap.set(label, { content: fileEntry.content });
    }

    // Case 1: File exists, no block
    if (fileEntry && !blockEntry) {
      if (lastBlockHash && !fileChanged) {
        // Block was deleted elsewhere; delete file
        await deleteMemoryFile(fileDir, label);
        deletedFiles.push(label);
        allFilesMap.delete(label);
        continue;
      }

      // Create block from file
      const blockData = parseBlockFromFileContent(fileEntry.content, label);
      const createdBlock = await client.blocks.create({
        ...blockData,
        tags: [`owner:${agentId}`],
      });
      if (createdBlock.id) {
        // Policy: attach if file is in system/, don't attach if at root
        if (fileInSystem) {
          await client.agents.blocks.attach(createdBlock.id, {
            agent_id: agentId,
          });
        }
        allBlocksMap.set(label, {
          value: createdBlock.value,
          id: createdBlock.id,
        });
      }
      createdBlocks.push(blockData.label);
      continue;
    }

    // Case 2: Block exists, no file
    if (!fileEntry && blockEntry) {
      if (lastFileHash && !blockChanged) {
        // File deleted, block unchanged → remove owner tag so file doesn't resurrect
        if (blockEntry.id) {
          try {
            if (isAttached) {
              // Detach the attached block first
              await client.agents.blocks.detach(blockEntry.id, {
                agent_id: agentId,
              });
            }
            // Remove owner tag from block
            const currentTags = blockEntry.tags || [];
            const newTags = currentTags.filter(
              (tag) => !tag.startsWith(`owner:${agentId}`),
            );
            await client.blocks.update(blockEntry.id, { tags: newTags });
            allBlocksMap.delete(label);
            deletedBlocks.push(label);
          } catch (err) {
            if (!(err instanceof Error && err.message.includes("Not Found"))) {
              throw err;
            }
          }
        }
        continue;
      }

      // Create file from block - use block's attached status to determine location
      const targetDir = isAttached ? systemDir : detachedDir;
      const fileContent = renderBlockToFileContent(blockEntry);
      await writeMemoryFile(targetDir, label, fileContent);
      createdFiles.push(label);
      allFilesMap.set(label, { content: fileContent });
      continue;
    }

    // Case 3: Neither exists (was in lastState but now gone)
    if (!fileEntry || !blockEntry) {
      continue;
    }

    // Case 4: Both exist - check for sync/conflict/location mismatch

    // Check for location mismatch: file location doesn't match block attachment
    const locationMismatch =
      (fileInSystem && !isAttached) || (!fileInSystem && isAttached);

    // If content matches but location mismatches, sync attachment to match file location
    // Use body hash (excludes frontmatter) for "content matches" check
    if (fileBodyHash === blockHash) {
      if (locationMismatch && blockEntry.id) {
        if (fileInSystem && !isAttached) {
          // File in system/, block detached → attach block
          await client.agents.blocks.attach(blockEntry.id, {
            agent_id: agentId,
          });
        } else if (!fileInSystem && isAttached) {
          // File at root, block attached → detach block
          await client.agents.blocks.detach(blockEntry.id, {
            agent_id: agentId,
          });
        }
      }
      continue;
    }

    // "FS wins all" policy: if file changed, file wins (even if block also changed)
    // Only conflict if explicit resolution provided but doesn't match
    if (
      fileChanged &&
      blockChanged &&
      resolution &&
      resolution.resolution === "block"
    ) {
      // User explicitly requested block wins via resolution for CONTENT
      // But FS still wins for LOCATION (attachment status)
      const fileContent = renderBlockToFileContent(blockEntry);
      await writeMemoryFile(fileDir, label, fileContent);
      updatedFiles.push(label);
      allFilesMap.set(label, { content: fileContent });

      // Sync attachment status to match file location (FS wins for location)
      if (locationMismatch && blockEntry.id) {
        if (fileInSystem && !isAttached) {
          await client.agents.blocks.attach(blockEntry.id, {
            agent_id: agentId,
          });
        } else if (!fileInSystem && isAttached) {
          await client.agents.blocks.detach(blockEntry.id, {
            agent_id: agentId,
          });
        }
      }
      continue;
    }

    // Handle explicit resolution override
    if (resolution?.resolution === "block") {
      // Block wins for CONTENT, but FS wins for LOCATION
      const fileContent = renderBlockToFileContent(blockEntry);
      await writeMemoryFile(fileDir, label, fileContent);
      updatedFiles.push(label);
      allFilesMap.set(label, { content: fileContent });

      // Sync attachment status to match file location (FS wins for location)
      if (locationMismatch && blockEntry.id) {
        if (fileInSystem && !isAttached) {
          await client.agents.blocks.attach(blockEntry.id, {
            agent_id: agentId,
          });
        } else if (!fileInSystem && isAttached) {
          await client.agents.blocks.detach(blockEntry.id, {
            agent_id: agentId,
          });
        }
      }
      continue;
    }

    // "FS wins all": if file changed at all, file wins (update block from file)
    // EXCEPT for read_only blocks - those are API → file only (ignore local changes)
    // Also sync attachment status to match file location
    if (fileChanged) {
      // Read-only blocks: ignore local changes, overwrite file with API content
      if (blockEntry.read_only) {
        const fileContent = renderBlockToFileContent(blockEntry);
        await writeMemoryFile(fileDir, label, fileContent);
        updatedFiles.push(label);
        allFilesMap.set(label, { content: fileContent });
        continue;
      }

      if (blockEntry.id) {
        try {
          // Use update-mode parsing to preserve metadata not in frontmatter
          const parsed = parseBlockUpdateFromFileContent(
            fileEntry.content,
            label,
          );
          const updatePayload: Record<string, unknown> = {
            value: parsed.value,
          };
          // Only include metadata if explicitly present in frontmatter
          if (parsed.hasDescription)
            updatePayload.description = parsed.description;
          if (parsed.hasLimit) updatePayload.limit = parsed.limit;
          if (parsed.hasReadOnly) updatePayload.read_only = parsed.read_only;
          // For detached blocks, also update label if changed
          if (!isAttached) updatePayload.label = label;
          await client.blocks.update(blockEntry.id, updatePayload);
          updatedBlocks.push(label);
          allBlocksMap.set(label, {
            value: parsed.value,
            id: blockEntry.id,
          });

          // Sync attachment status to match file location (FS wins for location too)
          if (locationMismatch) {
            if (fileInSystem && !isAttached) {
              await client.agents.blocks.attach(blockEntry.id, {
                agent_id: agentId,
              });
            } else if (!fileInSystem && isAttached) {
              await client.agents.blocks.detach(blockEntry.id, {
                agent_id: agentId,
              });
            }
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes("Not Found")) {
            // Block was deleted - create a new one
            const blockData = parseBlockFromFileContent(
              fileEntry.content,
              label,
            );
            const createdBlock = await client.blocks.create({
              ...blockData,
              tags: [`owner:${agentId}`],
            });
            if (createdBlock.id) {
              if (fileInSystem) {
                await client.agents.blocks.attach(createdBlock.id, {
                  agent_id: agentId,
                });
              }
              allBlocksMap.set(label, {
                value: createdBlock.value,
                id: createdBlock.id,
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

    // Only block changed (file unchanged) → update file from block
    // Also sync attachment status to match file location
    if (blockChanged) {
      const fileContent = renderBlockToFileContent(blockEntry);
      await writeMemoryFile(fileDir, label, fileContent);
      updatedFiles.push(label);
      allFilesMap.set(label, { content: fileContent });

      // Sync attachment status to match file location (FS wins for location)
      if (locationMismatch && blockEntry.id) {
        if (fileInSystem && !isAttached) {
          await client.agents.blocks.attach(blockEntry.id, {
            agent_id: agentId,
          });
        } else if (!fileInSystem && isAttached) {
          await client.agents.blocks.detach(blockEntry.id, {
            agent_id: agentId,
          });
        }
      }
    }
  }

  // Save state if no conflicts
  if (conflicts.length === 0) {
    const nextState = buildStateHashes(allBlocksMap, allFilesMap);
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

  // Prepend memory directory path (tilde format for readability)
  const memoryPath = `~/.letta/agents/${agentId}/memory`;
  const content = `Memory Directory: ${memoryPath}\n\n${tree}`;

  const client = await getClient();
  const blocks = await fetchAgentBlocks(agentId);
  const memfsBlock = blocks.find(
    (block) => block.label === MEMORY_FILESYSTEM_BLOCK_LABEL,
  );

  if (memfsBlock?.id) {
    await client.blocks.update(memfsBlock.id, { value: content });

    // Write file with frontmatter (consistent with other blocks)
    const fileContent = renderBlockToFileContent({
      value: content,
      description: memfsBlock.description,
      limit: memfsBlock.limit,
      read_only: memfsBlock.read_only,
    });
    await writeMemoryFile(
      systemDir,
      MEMORY_FILESYSTEM_BLOCK_LABEL,
      fileContent,
    );
  }
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
  const locationMismatches: string[] = [];

  // Discover detached blocks via owner tag
  const allOwnedBlocks = await fetchOwnedBlocks(agentId);
  const attachedIds = new Set(attachedBlocks.map((b) => b.id));
  const detachedBlocks = allOwnedBlocks.filter((b) => !attachedIds.has(b.id));

  const detachedBlockMap = new Map<string, Block>();
  for (const block of detachedBlocks) {
    if (block.label) {
      // Skip memfs-managed blocks
      if (MEMFS_MANAGED_LABELS.has(block.label)) {
        continue;
      }
      // Skip blocks whose label matches a system block (prevents duplicates)
      if (systemBlockMap.has(block.label)) {
        continue;
      }
      detachedBlockMap.set(block.label, block);
    }
  }

  // Unified label check - collect all labels and classify once
  const allLabels = new Set<string>([
    ...Array.from(systemFiles.keys()),
    ...Array.from(detachedFiles.keys()),
    ...Array.from(systemBlockMap.keys()),
    ...Array.from(detachedBlockMap.keys()),
    ...Object.keys(lastState.blockHashes),
    ...Object.keys(lastState.fileHashes),
  ]);

  for (const label of Array.from(allLabels).sort()) {
    // Skip memfs-managed blocks (memory_filesystem has special handling)
    if (MEMFS_MANAGED_LABELS.has(label)) continue;

    // Determine current state at runtime
    const systemFile = systemFiles.get(label);
    const detachedFile = detachedFiles.get(label);
    const attachedBlock = systemBlockMap.get(label);
    const detachedBlock = detachedBlockMap.get(label);

    const fileContent = systemFile?.content ?? detachedFile?.content ?? null;
    const blockValue = attachedBlock?.value ?? detachedBlock?.value ?? null;

    const fileInSystem = !!systemFile;
    const isAttached = !!attachedBlock;

    // Check for location mismatch (both file and block exist but location doesn't match)
    if (fileContent !== null && blockValue !== null) {
      const locationMismatch =
        (fileInSystem && !isAttached) || (!fileInSystem && isAttached);
      if (locationMismatch) {
        locationMismatches.push(label);
      }
    }

    classifyLabel(
      label,
      fileContent,
      blockValue,
      lastState.fileHashes[label] ?? null,
      lastState.blockHashes[label] ?? null,
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
    newBlocks.length === 0 &&
    locationMismatches.length === 0;

  return {
    conflicts,
    pendingFromFile,
    pendingFromBlock,
    newFiles,
    newBlocks,
    locationMismatches,
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
  _conflicts: MemorySyncConflict[], // Unused with "FS wins all" policy (kept for API compatibility)
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

  // "FS wins all" policy: if file changed at all, file wins
  // So both-changed is treated as pendingFromFile, not a conflict
  if (fileChanged) {
    pendingFromFile.push(label);
    return;
  }

  // Only block changed
  if (blockChanged) {
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
