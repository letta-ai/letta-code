import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

import type { Block } from "@letta-ai/letta-client/resources/agents/blocks";
import { getClient } from "./client";

export const MEMORY_FILESYSTEM_BLOCK_LABEL = "memory_filesystem";
export const MEMORY_FS_ROOT = ".letta";
export const MEMORY_FS_AGENTS_DIR = "agents";
export const MEMORY_FS_MEMORY_DIR = "memory";
export const MEMORY_SYSTEM_DIR = "system";
export const MEMORY_USER_DIR = "user";
export const MEMORY_FS_STATE_FILE = ".sync-state.json";

const MANAGED_BLOCK_LABELS = new Set([MEMORY_FILESYSTEM_BLOCK_LABEL]);

type SyncState = {
  systemBlocks: Record<string, string>;
  systemFiles: Record<string, string>;
  userBlocks: Record<string, string>;
  userFiles: Record<string, string>;
  userBlockIds: Record<string, string>;
  lastSync: string | null;
};

export type MemorySyncConflict = {
  label: string;
  blockValue: string | null;
  fileValue: string | null;
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

export function getMemoryUserDir(
  agentId: string,
  homeDir: string = homedir(),
): string {
  return join(getMemoryFilesystemRoot(agentId, homeDir), MEMORY_USER_DIR);
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
  const userDir = getMemoryUserDir(agentId, homeDir);

  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  if (!existsSync(systemDir)) {
    mkdirSync(systemDir, { recursive: true });
  }
  if (!existsSync(userDir)) {
    mkdirSync(userDir, { recursive: true });
  }
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
      userBlocks: {},
      userFiles: {},
      userBlockIds: {},
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
      userBlocks: parsed.userBlocks || {},
      userFiles: parsed.userFiles || {},
      userBlockIds: parsed.userBlockIds || {},
      lastSync: parsed.lastSync || null,
    };
  } catch {
    return {
      systemBlocks: {},
      systemFiles: {},
      userBlocks: {},
      userFiles: {},
      userBlockIds: {},
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

async function scanMdFiles(dir: string, baseDir = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await scanMdFiles(fullPath, baseDir)));
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

async function readMemoryFiles(
  dir: string,
): Promise<Map<string, { content: string; path: string }>> {
  const files = await scanMdFiles(dir);
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
  const blocksResponse = await client.agents.blocks.list(agentId);
  const blocks = Array.isArray(blocksResponse)
    ? blocksResponse
    : (blocksResponse as { items?: Block[] }).items ||
      (blocksResponse as { blocks?: Block[] }).blocks ||
      [];

  return blocks;
}

export function renderMemoryFilesystemTree(
  systemLabels: string[],
  userLabels: string[],
): string {
  type TreeNode = { children: Map<string, TreeNode>; isFile: boolean };

  const makeNode = (): TreeNode => ({ children: new Map(), isFile: false });
  const root = makeNode();

  const insertPath = (base: string, label: string) => {
    const parts = [base, ...label.split("/")];
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
  for (const label of userLabels) {
    insertPath(MEMORY_USER_DIR, label);
  }

  if (!root.children.has(MEMORY_SYSTEM_DIR)) {
    root.children.set(MEMORY_SYSTEM_DIR, makeNode());
  }
  if (!root.children.has(MEMORY_USER_DIR)) {
    root.children.set(MEMORY_USER_DIR, makeNode());
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
  userBlocks: Map<string, { value: string }>,
  userFiles: Map<string, { content: string }>,
  userBlockIds: Record<string, string>,
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

  userBlocks.forEach((block, label) => {
    userBlockHashes[label] = hashContent(block.value || "");
  });

  userFiles.forEach((file, label) => {
    userFileHashes[label] = hashContent(file.content || "");
  });

  return {
    systemBlocks: systemBlockHashes,
    systemFiles: systemFileHashes,
    userBlocks: userBlockHashes,
    userFiles: userFileHashes,
    userBlockIds,
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
  const userDir = getMemoryUserDir(agentId, homeDir);
  const systemFiles = await readMemoryFiles(systemDir);
  const userFiles = await readMemoryFiles(userDir);
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

  const userBlockIds = { ...lastState.userBlockIds };
  const userBlockMap = new Map<string, Block>();
  for (const [label, blockId] of Object.entries(userBlockIds)) {
    try {
      const block = await client.blocks.retrieve(blockId);
      userBlockMap.set(label, block as Block);
    } catch {
      delete userBlockIds[label];
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

      // Create block from file
      const createdBlock = await client.blocks.create({
        label,
        value: fileEntry.content,
        description: `Memory block: ${label}`,
        limit: 20000,
      });
      if (createdBlock.id) {
        await client.agents.blocks.attach(createdBlock.id, {
          agent_id: agentId,
        });
      }
      createdBlocks.push(label);
      continue;
    }

    if (!fileEntry && blockEntry) {
      if (lastFileHash && !blockChanged) {
        // File deleted, block unchanged -> delete block
        if (blockEntry.id) {
          try {
            await client.agents.blocks.detach(blockEntry.id, {
              agent_id: agentId,
            });
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

    if (fileChanged && blockChanged && !resolution) {
      conflicts.push({
        label,
        blockValue: blockEntry.value || "",
        fileValue: fileEntry.content,
      });
      continue;
    }

    if (resolution?.resolution === "file") {
      try {
        await client.agents.blocks.update(label, {
          agent_id: agentId,
          value: fileEntry.content,
        });
        updatedBlocks.push(label);
      } catch (err) {
        // Block may have been manually deleted - create it
        if (err instanceof Error && err.message.includes("Not Found")) {
          const createdBlock = await client.blocks.create({
            label,
            value: fileEntry.content,
            description: `Memory block: ${label}`,
            limit: 20000,
          });
          if (createdBlock.id) {
            await client.agents.blocks.attach(createdBlock.id, {
              agent_id: agentId,
            });
          }
          createdBlocks.push(label);
        } else {
          throw err;
        }
      }
      continue;
    }

    if (resolution?.resolution === "block") {
      await writeMemoryFile(systemDir, label, blockEntry.value || "");
      updatedFiles.push(label);
      continue;
    }

    if (fileChanged && !blockChanged) {
      try {
        await client.agents.blocks.update(label, {
          agent_id: agentId,
          value: fileEntry.content,
        });
        updatedBlocks.push(label);
      } catch (err) {
        // Block may have been manually deleted - create it
        if (err instanceof Error && err.message.includes("Not Found")) {
          const createdBlock = await client.blocks.create({
            label,
            value: fileEntry.content,
            description: `Memory block: ${label}`,
            limit: 20000,
          });
          if (createdBlock.id) {
            await client.agents.blocks.attach(createdBlock.id, {
              agent_id: agentId,
            });
          }
          createdBlocks.push(label);
        } else {
          throw err;
        }
      }
      continue;
    }

    if (!fileChanged && blockChanged) {
      await writeMemoryFile(systemDir, label, blockEntry.value || "");
      updatedFiles.push(label);
    }
  }

  const userLabels = new Set<string>([
    ...Array.from(userFiles.keys()),
    ...Array.from(userBlockMap.keys()),
    ...Object.keys(lastState.userBlocks),
    ...Object.keys(lastState.userFiles),
  ]);

  for (const label of Array.from(userLabels).sort()) {
    const fileEntry = userFiles.get(label);
    const blockEntry = userBlockMap.get(label);

    const fileHash = fileEntry ? hashContent(fileEntry.content) : null;
    const blockHash = blockEntry ? hashContent(blockEntry.value || "") : null;

    const lastFileHash = lastState.userFiles[label] || null;
    const lastBlockHash = lastState.userBlocks[label] || null;

    const fileChanged = fileHash !== lastFileHash;
    const blockChanged = blockHash !== lastBlockHash;

    const resolution = resolutions.get(label);

    if (fileEntry && !blockEntry) {
      if (lastBlockHash && !fileChanged) {
        // Block was deleted elsewhere; delete file.
        await deleteMemoryFile(userDir, label);
        deletedFiles.push(label);
        delete userBlockIds[label];
        continue;
      }

      const createdBlock = await client.blocks.create({
        label,
        value: fileEntry.content,
        description: `Memory block: ${label}`,
        limit: 20000,
      });
      if (createdBlock.id) {
        userBlockIds[label] = createdBlock.id;
        userBlockMap.set(label, createdBlock as Block);
      }
      createdBlocks.push(label);
      continue;
    }

    if (!fileEntry && blockEntry) {
      if (lastFileHash && !blockChanged) {
        // File deleted, block unchanged -> delete block
        if (blockEntry.id) {
          await client.blocks.delete(blockEntry.id);
        }
        deletedBlocks.push(label);
        delete userBlockIds[label];
        continue;
      }

      await writeMemoryFile(userDir, label, blockEntry.value || "");
      createdFiles.push(label);
      continue;
    }

    if (!fileEntry || !blockEntry) {
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
      await writeMemoryFile(userDir, label, blockEntry.value || "");
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
      await writeMemoryFile(userDir, label, blockEntry.value || "");
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
    const updatedUserFilesMap = await readMemoryFiles(userDir);
    const refreshedUserBlocks = new Map<string, { value: string }>();

    for (const [label, blockId] of Object.entries(userBlockIds)) {
      try {
        const block = await client.blocks.retrieve(blockId);
        refreshedUserBlocks.set(label, { value: block.value || "" });
      } catch {
        delete userBlockIds[label];
      }
    }

    const nextState = buildStateHashes(
      updatedSystemBlockMap,
      updatedSystemFilesMap,
      refreshedUserBlocks,
      updatedUserFilesMap,
      userBlockIds,
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
  const userDir = getMemoryUserDir(agentId, homeDir);

  const systemFiles = await readMemoryFiles(systemDir);
  const userFiles = await readMemoryFiles(userDir);

  const tree = renderMemoryFilesystemTree(
    Array.from(systemFiles.keys()).filter(
      (label) => label !== MEMORY_FILESYSTEM_BLOCK_LABEL,
    ),
    Array.from(userFiles.keys()),
  );

  const client = await getClient();
  await client.agents.blocks.update(MEMORY_FILESYSTEM_BLOCK_LABEL, {
    agent_id: agentId,
    value: tree,
  });

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
  const lines = ["Memory filesystem sync complete:"];
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

  return lines.join("\n");
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
