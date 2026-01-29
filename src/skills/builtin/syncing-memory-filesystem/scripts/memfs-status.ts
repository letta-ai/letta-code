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

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

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

// We can't import checkMemoryFilesystemStatus directly since it relies on
// getClient() which uses the CLI's auth chain. Instead, we reimplement the
// status check logic using the standalone client pattern.
// This keeps the script fully standalone and runnable outside the CLI process.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { relative } from "node:path";

const MEMORY_FS_STATE_FILE = ".sync-state.json";

type SyncState = {
  systemBlocks: Record<string, string>;
  systemFiles: Record<string, string>;
  detachedBlocks: Record<string, string>;
  detachedFiles: Record<string, string>;
  detachedBlockIds: Record<string, string>;
  lastSync: string | null;
};

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function getMemoryRoot(agentId: string): string {
  return join(homedir(), ".letta", "agents", agentId, "memory");
}

function loadSyncState(agentId: string): SyncState {
  const statePath = join(getMemoryRoot(agentId), MEMORY_FS_STATE_FILE);
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

async function scanMdFiles(dir: string, baseDir = dir): Promise<string[]> {
  if (!existsSync(dir)) return [];
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

function labelFromPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/\.md$/, "");
}

async function readMemoryFiles(
  dir: string,
): Promise<Map<string, { content: string }>> {
  const files = await scanMdFiles(dir);
  const entries = new Map<string, { content: string }>();
  for (const rel of files) {
    const label = labelFromPath(rel);
    const content = await readFile(join(dir, rel), "utf-8");
    entries.set(label, { content });
  }
  return entries;
}

const MANAGED_LABELS = new Set([
  "memory_filesystem",
  "skills",
  "loaded_skills",
]);

interface StatusResult {
  conflicts: Array<{ label: string }>;
  pendingFromFile: string[];
  pendingFromBlock: string[];
  newFiles: string[];
  newBlocks: string[];
  isClean: boolean;
  lastSync: string | null;
}

async function checkStatus(agentId: string): Promise<StatusResult> {
  const baseUrl = process.env.LETTA_BASE_URL || "https://api.letta.com";
  const client = new Letta({ apiKey: getApiKey(), baseUrl });

  const root = getMemoryRoot(agentId);
  const systemDir = join(root, "system");
  // Detached files go at root level (flat structure)
  const detachedDir = root;

  // Ensure directories exist
  for (const dir of [root, systemDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const systemFiles = await readMemoryFiles(systemDir);
  const detachedFiles = await readMemoryFiles(detachedDir);
  systemFiles.delete("memory_filesystem");

  // Fetch attached blocks
  const blocksResponse = await client.agents.blocks.list(agentId, {
    limit: 1000,
  });
  const blocks = Array.isArray(blocksResponse)
    ? blocksResponse
    : ((blocksResponse as { items?: unknown[] }).items as Array<{
        label?: string;
        value?: string;
      }>) || [];

  const systemBlockMap = new Map(
    blocks
      .filter((b: { label?: string }) => b.label)
      .map((b: { label?: string; value?: string }) => [
        b.label as string,
        b.value || "",
      ]),
  );
  systemBlockMap.delete("memory_filesystem");

  const lastState = loadSyncState(agentId);

  const conflicts: Array<{ label: string }> = [];
  const pendingFromFile: string[] = [];
  const pendingFromBlock: string[] = [];
  const newFiles: string[] = [];
  const newBlocks: string[] = [];

  // Fetch user blocks
  const detachedBlockMap = new Map<string, string>();
  for (const [label, blockId] of Object.entries(lastState.detachedBlockIds)) {
    try {
      const block = await client.blocks.retrieve(blockId);
      detachedBlockMap.set(label, block.value || "");
    } catch {
      // Block no longer exists
    }
  }

  function classify(
    label: string,
    fileContent: string | null,
    blockValue: string | null,
    lastFileHash: string | null,
    lastBlockHash: string | null,
  ) {
    const fileHash = fileContent !== null ? hashContent(fileContent) : null;
    const blockHash = blockValue !== null ? hashContent(blockValue) : null;
    const fileChanged = fileHash !== lastFileHash;
    const blockChanged = blockHash !== lastBlockHash;

    if (fileContent !== null && blockValue === null) {
      if (lastBlockHash && !fileChanged) return;
      newFiles.push(label);
      return;
    }
    if (fileContent === null && blockValue !== null) {
      if (lastFileHash && !blockChanged) return;
      newBlocks.push(label);
      return;
    }
    if (fileContent === null || blockValue === null) return;
    if (fileHash === blockHash) return;
    if (fileChanged && blockChanged) {
      conflicts.push({ label });
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

  // Check system labels
  const systemLabels = new Set([
    ...systemFiles.keys(),
    ...systemBlockMap.keys(),
    ...Object.keys(lastState.systemBlocks),
    ...Object.keys(lastState.systemFiles),
  ]);

  for (const label of [...systemLabels].sort()) {
    if (MANAGED_LABELS.has(label)) continue;
    classify(
      label,
      systemFiles.get(label)?.content ?? null,
      systemBlockMap.get(label) ?? null,
      lastState.systemFiles[label] ?? null,
      lastState.systemBlocks[label] ?? null,
    );
  }

  // Check user labels
  const userLabels = new Set([
    ...detachedFiles.keys(),
    ...detachedBlockMap.keys(),
    ...Object.keys(lastState.detachedBlocks),
    ...Object.keys(lastState.detachedFiles),
  ]);

  for (const label of [...userLabels].sort()) {
    classify(
      label,
      detachedFiles.get(label)?.content ?? null,
      detachedBlockMap.get(label) ?? null,
      lastState.detachedFiles[label] ?? null,
      lastState.detachedBlocks[label] ?? null,
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
