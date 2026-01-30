#!/usr/bin/env npx tsx
/**
 * Memory Filesystem Status Check
 *
 * Read-only check of the current memFS sync status.
 * Shows conflicts, pending changes, and overall sync health.
 * Analogous to `git status`.
 *
 * Usage:
 *   npx tsx memfs-status.ts <agent-id>
 *
 * Output: JSON object with sync status
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const require = createRequire(import.meta.url);
const Letta = require("@letta-ai/letta-client")
  .default as typeof import("@letta-ai/letta-client").default;

function getApiKey(): string {
  if (process.env.LETTA_API_KEY) {
    return process.env.LETTA_API_KEY;
  }

  const settingsPath = join(homedir(), ".letta", "settings.json");
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (settings.env?.LETTA_API_KEY) {
      return settings.env.LETTA_API_KEY;
    }
  } catch {
    // Settings file doesn't exist or is invalid
  }

  throw new Error(
    "No LETTA_API_KEY found. Set the env var or run the Letta CLI to authenticate.",
  );
}

const MEMORY_FS_STATE_FILE = ".sync-state.json";

// Unified sync state format (matches main memoryFilesystem.ts)
type SyncState = {
  blockHashes: Record<string, string>;
  fileHashes: Record<string, string>;
  blockIds: Record<string, string>;
  lastSync: string | null;
};

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Parse frontmatter from file content.
 */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match || !match[1] || !match[2]) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterText = match[1];
  const body = match[2];
  const frontmatter: Record<string, string> = {};

  for (const line of frontmatterText.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

/**
 * Hash just the body of file content (excluding frontmatter).
 */
function hashFileBody(content: string): string {
  const { body } = parseFrontmatter(content);
  return hashContent(body);
}

function getMemoryRoot(agentId: string): string {
  return join(homedir(), ".letta", "agents", agentId, "memory");
}

function loadSyncState(agentId: string): SyncState {
  const statePath = join(getMemoryRoot(agentId), MEMORY_FS_STATE_FILE);
  if (!existsSync(statePath)) {
    return {
      blockHashes: {},
      fileHashes: {},
      blockIds: {},
      lastSync: null,
    };
  }

  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      blockHashes: parsed.blockHashes || {},
      fileHashes: parsed.fileHashes || {},
      blockIds: parsed.blockIds || {},
      lastSync: parsed.lastSync || null,
    };
  } catch {
    return {
      blockHashes: {},
      fileHashes: {},
      blockIds: {},
      lastSync: null,
    };
  }
}

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

function labelFromPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/\.md$/, "");
}

async function readMemoryFiles(
  dir: string,
  excludeDirs: string[] = [],
): Promise<Map<string, { content: string }>> {
  const files = await scanMdFiles(dir, dir, excludeDirs);
  const entries = new Map<string, { content: string }>();
  for (const rel of files) {
    const label = labelFromPath(rel);
    const content = await readFile(join(dir, rel), "utf-8");
    entries.set(label, { content });
  }
  return entries;
}

// Only memory_filesystem is managed by memfs itself
const MEMFS_MANAGED_LABELS = new Set(["memory_filesystem"]);

interface StatusResult {
  conflicts: Array<{ label: string }>;
  pendingFromFile: string[];
  pendingFromBlock: string[];
  newFiles: string[];
  newBlocks: string[];
  locationMismatches: string[];
  isClean: boolean;
  lastSync: string | null;
}

async function checkStatus(agentId: string): Promise<StatusResult> {
  const baseUrl = process.env.LETTA_BASE_URL || "https://api.letta.com";
  const client = new Letta({ apiKey: getApiKey(), baseUrl });

  const root = getMemoryRoot(agentId);
  const systemDir = join(root, "system");
  const detachedDir = root;

  // Ensure directories exist
  for (const dir of [root, systemDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Read files from both locations
  const systemFiles = await readMemoryFiles(systemDir);
  const detachedFiles = await readMemoryFiles(detachedDir, ["system", "user"]);

  // Fetch attached blocks
  const blocksResponse = await client.agents.blocks.list(agentId, {
    limit: 1000,
  });
  const attachedBlocks = Array.isArray(blocksResponse)
    ? blocksResponse
    : ((blocksResponse as { items?: unknown[] }).items as Array<{
        id?: string;
        label?: string;
        value?: string;
        read_only?: boolean;
      }>) || [];

  const systemBlockMap = new Map<
    string,
    { value: string; id: string; read_only?: boolean }
  >();
  for (const block of attachedBlocks) {
    if (block.label && block.id) {
      systemBlockMap.set(block.label, {
        value: block.value || "",
        id: block.id,
        read_only: block.read_only,
      });
    }
  }

  // Fetch detached blocks via owner tag
  const ownedBlocksResponse = await client.blocks.list({
    tags: [`owner:${agentId}`],
    limit: 1000,
  });
  const ownedBlocks = Array.isArray(ownedBlocksResponse)
    ? ownedBlocksResponse
    : ((ownedBlocksResponse as { items?: unknown[] }).items as Array<{
        id?: string;
        label?: string;
        value?: string;
        read_only?: boolean;
      }>) || [];

  const attachedIds = new Set(attachedBlocks.map((b) => b.id));
  const detachedBlockMap = new Map<
    string,
    { value: string; id: string; read_only?: boolean }
  >();
  for (const block of ownedBlocks) {
    if (block.label && block.id && !attachedIds.has(block.id)) {
      if (!systemBlockMap.has(block.label)) {
        detachedBlockMap.set(block.label, {
          value: block.value || "",
          id: block.id,
          read_only: block.read_only,
        });
      }
    }
  }

  const lastState = loadSyncState(agentId);

  const conflicts: Array<{ label: string }> = [];
  const pendingFromFile: string[] = [];
  const pendingFromBlock: string[] = [];
  const newFiles: string[] = [];
  const newBlocks: string[] = [];
  const locationMismatches: string[] = [];

  // Collect all labels
  const allLabels = new Set<string>([
    ...systemFiles.keys(),
    ...detachedFiles.keys(),
    ...systemBlockMap.keys(),
    ...detachedBlockMap.keys(),
    ...Object.keys(lastState.blockHashes),
    ...Object.keys(lastState.fileHashes),
  ]);

  for (const label of [...allLabels].sort()) {
    if (MEMFS_MANAGED_LABELS.has(label)) continue;

    const systemFile = systemFiles.get(label);
    const detachedFile = detachedFiles.get(label);
    const attachedBlock = systemBlockMap.get(label);
    const detachedBlock = detachedBlockMap.get(label);

    const fileEntry = systemFile || detachedFile;
    const fileInSystem = !!systemFile;
    const blockEntry = attachedBlock || detachedBlock;
    const isAttached = !!attachedBlock;

    // Check for location mismatch
    if (fileEntry && blockEntry) {
      const locationMismatch =
        (fileInSystem && !isAttached) || (!fileInSystem && isAttached);
      if (locationMismatch) {
        locationMismatches.push(label);
      }
    }

    // Compute hashes
    // Full file hash for "file changed" check (matches what's stored in fileHashes)
    const fileHash = fileEntry ? hashContent(fileEntry.content) : null;
    // Body hash for "content matches" check (compares to block value)
    const fileBodyHash = fileEntry ? hashFileBody(fileEntry.content) : null;
    const blockHash = blockEntry ? hashContent(blockEntry.value) : null;

    const lastFileHash = lastState.fileHashes[label] ?? null;
    const lastBlockHash = lastState.blockHashes[label] ?? null;

    const fileChanged = fileHash !== lastFileHash;
    const blockChanged = blockHash !== lastBlockHash;

    // Classify
    if (fileEntry && !blockEntry) {
      if (lastBlockHash && !fileChanged) continue; // Block deleted, file unchanged
      newFiles.push(label);
      continue;
    }

    if (!fileEntry && blockEntry) {
      if (lastFileHash && !blockChanged) continue; // File deleted, block unchanged
      newBlocks.push(label);
      continue;
    }

    if (!fileEntry || !blockEntry) continue;

    // Both exist - check if content matches (body vs block value)
    if (fileBodyHash === blockHash) continue; // In sync

    // "FS wins all" policy: if file changed, treat as pendingFromFile
    if (fileChanged) {
      pendingFromFile.push(label);
      continue;
    }

    if (blockChanged) {
      pendingFromBlock.push(label);
    }
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
    lastSync: lastState.lastSync,
  };
}

// CLI Entry Point
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
Usage: npx tsx memfs-status.ts <agent-id>

Shows the current memFS sync status (read-only).
Analogous to 'git status'.

Arguments:
  agent-id     Agent ID to check (can use $LETTA_AGENT_ID)

Output: JSON object with:
  - conflicts: blocks where both file and block changed
  - pendingFromFile: file changed, block didn't
  - pendingFromBlock: block changed, file didn't
  - newFiles: file exists without a block
  - newBlocks: block exists without a file
  - locationMismatches: file/block location doesn't match attachment
  - isClean: true if everything is in sync
  - lastSync: timestamp of last sync
    `);
    process.exit(0);
  }

  const agentId = args[0];
  if (!agentId) {
    console.error("Error: agent-id is required");
    process.exit(1);
  }

  checkStatus(agentId)
    .then((status) => {
      console.log(JSON.stringify(status, null, 2));
    })
    .catch((error) => {
      console.error(
        "Error checking memFS status:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    });
}
