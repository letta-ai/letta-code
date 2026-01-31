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

  return { frontmatter, body: body.trim() };
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

interface Conflict {
  label: string;
  fileContent: string;
  blockContent: string;
}

interface MetadataChange {
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

async function findConflicts(agentId: string): Promise<{
  conflicts: Conflict[];
  metadataOnly: MetadataChange[];
}> {
  const baseUrl = process.env.LETTA_BASE_URL || "https://api.letta.com";
  const client = new Letta({ apiKey: getApiKey(), baseUrl });

  const root = getMemoryRoot(agentId);
  const systemDir = join(root, "system");
  const detachedDir = root;

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
  const conflicts: Conflict[] = [];
  const metadataOnly: MetadataChange[] = [];

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
    const blockEntry = attachedBlock || detachedBlock;

    if (!fileEntry || !blockEntry) continue;

    // read_only blocks are API-authoritative; no conflicts possible
    if (blockEntry.read_only) continue;

    // Full file hash for "file changed" check
    const fileHash = hashContent(fileEntry.content);
    // Body hash for "content matches" check
    const fileBodyHash = hashFileBody(fileEntry.content);
    const blockHash = hashContent(blockEntry.value);

    const lastFileHash = lastState.fileHashes[label] ?? null;
    const lastBlockHash = lastState.blockHashes[label] ?? null;
    const fileChanged = fileHash !== lastFileHash;
    const blockChanged = blockHash !== lastBlockHash;

    // Content matches - check for frontmatter-only changes
    if (fileBodyHash === blockHash) {
      if (fileChanged) {
        metadataOnly.push({
          label,
          fileContent: fileEntry.content,
          blockContent: blockEntry.value,
        });
      }
      continue;
    }

    // Conflict only if both changed
    if (fileChanged && blockChanged) {
      conflicts.push({
        label,
        fileContent: fileEntry.content,
        blockContent: blockEntry.value,
      });
    }
  }

  return { conflicts, metadataOnly };
}

function formatDiffFile(
  conflicts: Conflict[],
  metadataOnly: MetadataChange[],
  agentId: string,
): string {
  const lines: string[] = [
    `# Memory Filesystem Diff`,
    ``,
    `Agent: ${agentId}`,
    `Generated: ${new Date().toISOString()}`,
    `Conflicts: ${conflicts.length}`,
    `Metadata-only changes: ${metadataOnly.length}`,
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

  if (metadataOnly.length > 0) {
    lines.push(`## Metadata-only Changes`);
    lines.push(``);
    lines.push(
      `Frontmatter changed while body content stayed the same (file wins).`,
    );
    lines.push(``);

    for (const change of metadataOnly) {
      lines.push(`### ${change.label}`);
      lines.push(``);
      lines.push(`#### File Version (with frontmatter)`);
      lines.push(`\`\`\``);
      lines.push(change.fileContent);
      lines.push(`\`\`\``);
      lines.push(``);
      lines.push(`#### Block Version (body only)`);
      lines.push(`\`\`\``);
      lines.push(change.blockContent);
      lines.push(`\`\`\``);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }
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
    .then(({ conflicts, metadataOnly }) => {
      if (conflicts.length === 0 && metadataOnly.length === 0) {
        console.log("No conflicts found. Memory filesystem is clean.");
        return;
      }

      const diffContent = formatDiffFile(conflicts, metadataOnly, agentId);

      // Write to overflow directory (same pattern as tool output overflow)
      const overflowDir = getOverflowDirectory();
      if (!existsSync(overflowDir)) {
        mkdirSync(overflowDir, { recursive: true });
      }

      const filename = `memfs-diff-${randomUUID()}.md`;
      const diffPath = join(overflowDir, filename);
      writeFileSync(diffPath, diffContent, "utf-8");

      console.log(
        `Diff (${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}, ${metadataOnly.length} metadata-only change${metadataOnly.length === 1 ? "" : "s"}) written to: ${diffPath}`,
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
