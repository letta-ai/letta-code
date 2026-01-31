#!/usr/bin/env npx tsx
/**
 * Memory Filesystem Conflict Resolver
 *
 * Resolves all memFS sync conflicts in a single stateless call.
 * The agent provides all resolutions up front as JSON.
 * Analogous to `git merge` / `git checkout --theirs/--ours`.
 *
 * Usage:
 *   npx tsx memfs-resolve.ts <agent-id> --resolutions '<JSON>'
 *
 * Example:
 *   npx tsx memfs-resolve.ts $LETTA_AGENT_ID --resolutions '[{"label":"persona/soul","resolution":"block"},{"label":"human/prefs","resolution":"file"}]'
 *
 * Resolution options per conflict:
 *   "file"  — Overwrite the memory block with the file contents
 *   "block" — Overwrite the file with the memory block contents
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

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

interface Resolution {
  label: string;
  resolution: "file" | "block";
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
 * Parse block update from file content (update-mode: only update metadata if present in frontmatter).
 */
function parseBlockUpdateFromFileContent(
  fileContent: string,
  defaultLabel: string,
): {
  label: string;
  value: string;
  description?: string;
  limit?: number;
  read_only?: boolean;
  hasDescription: boolean;
  hasLimit: boolean;
  hasReadOnly: boolean;
} {
  const { frontmatter, body } = parseFrontmatter(fileContent);
  const label = frontmatter.label || defaultLabel;
  const hasDescription = Object.hasOwn(frontmatter, "description");
  const hasLimit = Object.hasOwn(frontmatter, "limit");
  const hasReadOnly = Object.hasOwn(frontmatter, "read_only");

  let limit: number | undefined;
  if (hasLimit && frontmatter.limit) {
    const parsed = parseInt(frontmatter.limit, 10);
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

/**
 * Render block to file content with frontmatter.
 */
function renderBlockToFileContent(block: {
  value?: string | null;
  description?: string | null;
  limit?: number | null;
  read_only?: boolean | null;
}): string {
  const lines: string[] = ["---"];
  if (block.description) {
    // Escape quotes in description
    const escaped = block.description.replace(/"/g, '\\"');
    lines.push(`description: "${escaped}"`);
  }
  if (block.limit) {
    lines.push(`limit: ${block.limit}`);
  }
  if (block.read_only === true) {
    lines.push("read_only: true");
  }
  lines.push("---", "", block.value || "");
  return lines.join("\n");
}

function getMemoryRoot(agentId: string): string {
  return join(homedir(), ".letta", "agents", agentId, "memory");
}

function saveSyncState(state: SyncState, agentId: string): void {
  const statePath = join(getMemoryRoot(agentId), MEMORY_FS_STATE_FILE);
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
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

function writeMemoryFile(dir: string, label: string, content: string): void {
  const filePath = join(dir, `${label}.md`);
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(filePath, content, "utf-8");
}

interface ResolveResult {
  resolved: Array<{ label: string; resolution: string; action: string }>;
  errors: Array<{ label: string; error: string }>;
}

async function resolveConflicts(
  agentId: string,
  resolutions: Resolution[],
): Promise<ResolveResult> {
  const baseUrl = process.env.LETTA_BASE_URL || "https://api.letta.com";
  const client = new Letta({ apiKey: getApiKey(), baseUrl });

  const root = getMemoryRoot(agentId);
  const systemDir = join(root, "system");
  const detachedDir = root;

  for (const dir of [root, systemDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Read current state
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
        description?: string | null;
        limit?: number | null;
        read_only?: boolean;
      }>) || [];

  const systemBlockMap = new Map<
    string,
    {
      id: string;
      value: string;
      description?: string | null;
      limit?: number | null;
      read_only?: boolean;
    }
  >();
  for (const block of attachedBlocks) {
    if (block.label && block.id) {
      systemBlockMap.set(block.label, {
        id: block.id,
        value: block.value || "",
        description: block.description,
        limit: block.limit,
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
        description?: string | null;
        limit?: number | null;
        read_only?: boolean;
      }>) || [];

  const attachedIds = new Set(attachedBlocks.map((b) => b.id));
  const detachedBlockMap = new Map<
    string,
    {
      id: string;
      value: string;
      description?: string | null;
      limit?: number | null;
      read_only?: boolean;
    }
  >();
  for (const block of ownedBlocks) {
    if (block.label && block.id && !attachedIds.has(block.id)) {
      if (!systemBlockMap.has(block.label)) {
        detachedBlockMap.set(block.label, {
          id: block.id,
          value: block.value || "",
          description: block.description,
          limit: block.limit,
          read_only: block.read_only,
        });
      }
    }
  }

  const result: ResolveResult = { resolved: [], errors: [] };

  for (const { label, resolution } of resolutions) {
    try {
      // Check system blocks/files first, then detached blocks/files
      const systemBlock = systemBlockMap.get(label);
      const systemFile = systemFiles.get(label);
      const detachedBlock = detachedBlockMap.get(label);
      const detachedFile = detachedFiles.get(label);

      const block = systemBlock || detachedBlock;
      const file = systemFile || detachedFile;
      const dir =
        systemBlock || systemFile
          ? systemDir
          : detachedBlock || detachedFile
            ? detachedDir
            : null;

      if (!block || !file || !dir) {
        result.errors.push({
          label,
          error: `Could not find both block and file for label "${label}"`,
        });
        continue;
      }

      if (resolution === "file") {
        // read_only blocks: ignore local edits, overwrite file from API
        if (block.read_only) {
          const fileContent = renderBlockToFileContent(block);
          writeMemoryFile(dir, label, fileContent);
          result.resolved.push({
            label,
            resolution: "block",
            action: "read_only: kept API version (file overwritten)",
          });
          continue;
        }

        // Use update-mode parsing (only update metadata if present in frontmatter)
        const parsed = parseBlockUpdateFromFileContent(file.content, label);
        const updatePayload: Record<string, unknown> = { value: parsed.value };
        if (parsed.hasDescription)
          updatePayload.description = parsed.description;
        if (parsed.hasLimit) updatePayload.limit = parsed.limit;
        if (parsed.hasReadOnly) updatePayload.read_only = parsed.read_only;
        // For detached blocks, also update label if changed
        if (!systemBlock) updatePayload.label = label;

        await client.blocks.update(block.id, updatePayload);
        result.resolved.push({
          label,
          resolution: "file",
          action: "Updated block from file",
        });
      } else if (resolution === "block") {
        // Overwrite file with block content (including frontmatter)
        const fileContent = renderBlockToFileContent(block);
        writeMemoryFile(dir, label, fileContent);
        result.resolved.push({
          label,
          resolution: "block",
          action: "Updated file from block",
        });
      }
    } catch (error) {
      result.errors.push({
        label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Rebuild sync state in unified format
  const updatedSystemFiles = await readMemoryFiles(systemDir);
  const updatedDetachedFiles = await readMemoryFiles(detachedDir, [
    "system",
    "user",
  ]);

  // Re-fetch all owned blocks
  const updatedOwnedResp = await client.blocks.list({
    tags: [`owner:${agentId}`],
    limit: 1000,
  });
  const updatedOwnedBlocks = Array.isArray(updatedOwnedResp)
    ? updatedOwnedResp
    : ((updatedOwnedResp as { items?: unknown[] }).items as Array<{
        id?: string;
        label?: string;
        value?: string;
      }>) || [];

  const blockHashes: Record<string, string> = {};
  const blockIds: Record<string, string> = {};
  for (const b of updatedOwnedBlocks) {
    if (b.label && b.id) {
      blockHashes[b.label] = hashContent(b.value || "");
      blockIds[b.label] = b.id;
    }
  }

  const fileHashes: Record<string, string> = {};
  for (const [lbl, f] of updatedSystemFiles) {
    fileHashes[lbl] = hashContent(f.content);
  }
  for (const [lbl, f] of updatedDetachedFiles) {
    fileHashes[lbl] = hashContent(f.content);
  }

  saveSyncState(
    {
      blockHashes,
      fileHashes,
      blockIds,
      lastSync: new Date().toISOString(),
    },
    agentId,
  );

  return result;
}

// CLI Entry Point
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
Usage: npx tsx memfs-resolve.ts <agent-id> --resolutions '<JSON>'

Resolves all memory filesystem sync conflicts in one call.
Analogous to 'git merge' with explicit resolution choices.

Arguments:
  agent-id        Agent ID (can use $LETTA_AGENT_ID)
  --resolutions   JSON array of resolutions

Resolution format:
  [{"label": "persona/soul", "resolution": "block"}, {"label": "human/prefs", "resolution": "file"}]

Resolution options:
  "file"  — Overwrite the memory block with the file contents
  "block" — Overwrite the file with the memory block contents

Note: read_only blocks always resolve to "block" (API is authoritative).

Example:
  npx tsx memfs-resolve.ts $LETTA_AGENT_ID --resolutions '[{"label":"persona/soul","resolution":"block"}]'
    `);
    process.exit(0);
  }

  const agentId = args[0];
  if (!agentId) {
    console.error("Error: agent-id is required");
    process.exit(1);
  }

  // Parse --resolutions flag
  const resolutionsIdx = args.indexOf("--resolutions");
  if (resolutionsIdx === -1 || resolutionsIdx + 1 >= args.length) {
    console.error("Error: --resolutions '<JSON>' is required");
    process.exit(1);
  }

  let resolutions: Resolution[];
  try {
    resolutions = JSON.parse(args[resolutionsIdx + 1]);
    if (!Array.isArray(resolutions)) {
      throw new Error("Resolutions must be a JSON array");
    }
    for (const r of resolutions) {
      if (!r.label || !r.resolution) {
        throw new Error(
          `Each resolution must have "label" and "resolution" fields`,
        );
      }
      if (r.resolution !== "file" && r.resolution !== "block") {
        throw new Error(
          `Resolution must be "file" or "block", got "${r.resolution}"`,
        );
      }
    }
  } catch (error) {
    console.error(
      "Error parsing resolutions:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }

  resolveConflicts(agentId, resolutions)
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
    })
    .catch((error) => {
      console.error(
        "Error resolving conflicts:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    });
}
