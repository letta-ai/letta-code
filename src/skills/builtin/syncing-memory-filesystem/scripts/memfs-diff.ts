#!/usr/bin/env npx tsx
/**
 * Memory Filesystem Diff
 *
 * Shows the full content of conflicting blocks and files.
 * Writes a formatted markdown diff to a file for review.
 * Analogous to `git diff`.
 *
 * Usage:
 *   npx tsx memfs-diff.ts <agent-id>
 *
 * Output: Path to the diff file (or "No conflicts" message)
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, normalize, relative } from "node:path";

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

interface Conflict {
  label: string;
  fileContent: string;
  blockContent: string;
}

/**
 * Get the overflow directory following the same pattern as tool output overflow.
 * Pattern: ~/.letta/projects/<project-path>/agent-tools/
 */
function getOverflowDirectory(): string {
  const cwd = process.cwd();
  const normalizedPath = normalize(cwd);
  const sanitizedPath = normalizedPath
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "_")
    .replace(/\s+/g, "_");

  return join(homedir(), ".letta", "projects", sanitizedPath, "agent-tools");
}

async function findConflicts(agentId: string): Promise<Conflict[]> {
  const baseUrl = process.env.LETTA_BASE_URL || "https://api.letta.com";
  const client = new Letta({ apiKey: getApiKey(), baseUrl });

  const root = getMemoryRoot(agentId);
  const systemDir = join(root, "system");
  // Detached files go at root level (flat structure)
  const detachedDir = root;

  for (const dir of [root, systemDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const systemFiles = await readMemoryFiles(systemDir);
  const detachedFiles = await readMemoryFiles(detachedDir);
  systemFiles.delete("memory_filesystem");

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

  const detachedBlockMap = new Map<string, string>();
  for (const [label, blockId] of Object.entries(lastState.detachedBlockIds)) {
    try {
      const block = await client.blocks.retrieve(blockId);
      detachedBlockMap.set(label, block.value || "");
    } catch {
      // Block no longer exists
    }
  }

  const conflicts: Conflict[] = [];

  function checkConflict(
    label: string,
    fileContent: string | null,
    blockValue: string | null,
    lastFileHash: string | null,
    lastBlockHash: string | null,
  ) {
    if (fileContent === null || blockValue === null) return;
    const fileHash = hashContent(fileContent);
    const blockHash = hashContent(blockValue);
    if (fileHash === blockHash) return;
    const fileChanged = fileHash !== lastFileHash;
    const blockChanged = blockHash !== lastBlockHash;
    if (fileChanged && blockChanged) {
      conflicts.push({ label, fileContent, blockContent: blockValue });
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
    checkConflict(
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
    checkConflict(
      label,
      detachedFiles.get(label)?.content ?? null,
      detachedBlockMap.get(label) ?? null,
      lastState.detachedFiles[label] ?? null,
      lastState.detachedBlocks[label] ?? null,
    );
  }

  return conflicts;
}

function formatDiffFile(conflicts: Conflict[], agentId: string): string {
  const lines: string[] = [
    `# Memory Filesystem Diff`,
    ``,
    `Agent: ${agentId}`,
    `Generated: ${new Date().toISOString()}`,
    `Conflicts: ${conflicts.length}`,
    ``,
    `---`,
    ``,
  ];

  for (const conflict of conflicts) {
    lines.push(`## Conflict: ${conflict.label}`);
    lines.push(``);
    lines.push(`### File Version`);
    lines.push(`\`\`\``);
    lines.push(conflict.fileContent);
    lines.push(`\`\`\``);
    lines.push(``);
    lines.push(`### Block Version`);
    lines.push(`\`\`\``);
    lines.push(conflict.blockContent);
    lines.push(`\`\`\``);
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  return lines.join("\n");
}

// CLI Entry Point
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
Usage: npx tsx memfs-diff.ts <agent-id>

Shows the full content of conflicting memory blocks and files.
Writes a formatted diff to a file for review.
Analogous to 'git diff'.

Arguments:
  agent-id     Agent ID to check (can use $LETTA_AGENT_ID)

Output: Path to the diff file, or a message if no conflicts exist.
    `);
    process.exit(0);
  }

  const agentId = args[0];
  if (!agentId) {
    console.error("Error: agent-id is required");
    process.exit(1);
  }

  findConflicts(agentId)
    .then((conflicts) => {
      if (conflicts.length === 0) {
        console.log("No conflicts found. Memory filesystem is clean.");
        return;
      }

      const diffContent = formatDiffFile(conflicts, agentId);

      // Write to overflow directory (same pattern as tool output overflow)
      const overflowDir = getOverflowDirectory();
      if (!existsSync(overflowDir)) {
        mkdirSync(overflowDir, { recursive: true });
      }

      const filename = `memfs-diff-${randomUUID()}.md`;
      const diffPath = join(overflowDir, filename);
      writeFileSync(diffPath, diffContent, "utf-8");

      console.log(
        `Diff (${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}) written to: ${diffPath}`,
      );
    })
    .catch((error) => {
      console.error(
        "Error generating memFS diff:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    });
}
