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

type SyncState = {
  systemBlocks: Record<string, string>;
  systemFiles: Record<string, string>;
  userBlocks: Record<string, string>;
  userFiles: Record<string, string>;
  userBlockIds: Record<string, string>;
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

function saveSyncState(state: SyncState, agentId: string): void {
  const statePath = join(getMemoryRoot(agentId), MEMORY_FS_STATE_FILE);
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
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
  const userDir = join(root, "user");

  for (const dir of [root, systemDir, userDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Read current state
  const systemFiles = await readMemoryFiles(systemDir);
  const userFiles = await readMemoryFiles(userDir);
  systemFiles.delete("memory_filesystem");

  const blocksResponse = await client.agents.blocks.list(agentId, {
    limit: 1000,
  });
  const blocks = Array.isArray(blocksResponse)
    ? blocksResponse
    : ((blocksResponse as { items?: unknown[] }).items as Array<{
        id?: string;
        label?: string;
        value?: string;
      }>) || [];

  const systemBlockMap = new Map(
    blocks
      .filter((b: { label?: string }) => b.label)
      .map((b: { id?: string; label?: string; value?: string }) => [
        b.label as string,
        { id: b.id || "", value: b.value || "" },
      ]),
  );

  const lastState = loadSyncState(agentId);
  const userBlockMap = new Map<string, { id: string; value: string }>();
  for (const [label, blockId] of Object.entries(lastState.userBlockIds)) {
    try {
      const block = await client.blocks.retrieve(blockId);
      userBlockMap.set(label, { id: block.id || "", value: block.value || "" });
    } catch {
      // Block no longer exists
    }
  }

  const result: ResolveResult = { resolved: [], errors: [] };

  for (const { label, resolution } of resolutions) {
    try {
      // Check system blocks/files first, then user blocks/files
      const systemBlock = systemBlockMap.get(label);
      const systemFile = systemFiles.get(label);
      const userBlock = userBlockMap.get(label);
      const userFile = userFiles.get(label);

      const block = systemBlock || userBlock;
      const file = systemFile || userFile;
      const dir =
        systemBlock || systemFile
          ? systemDir
          : userBlock || userFile
            ? userDir
            : null;

      if (!block || !file || !dir) {
        result.errors.push({
          label,
          error: `Could not find both block and file for label "${label}"`,
        });
        continue;
      }

      if (resolution === "file") {
        // Overwrite block with file content
        await client.blocks.update(block.id, { value: file.content });
        result.resolved.push({
          label,
          resolution: "file",
          action: "Updated block with file content",
        });
      } else if (resolution === "block") {
        // Overwrite file with block content
        writeMemoryFile(dir, label, block.value);
        result.resolved.push({
          label,
          resolution: "block",
          action: "Updated file with block content",
        });
      }
    } catch (error) {
      result.errors.push({
        label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Update sync state after resolving all conflicts
  // Re-read everything to capture the new state
  const updatedSystemFiles = await readMemoryFiles(systemDir);
  const updatedUserFiles = await readMemoryFiles(userDir);
  updatedSystemFiles.delete("memory_filesystem");

  const updatedBlocksResponse = await client.agents.blocks.list(agentId, {
    limit: 1000,
  });
  const updatedBlocks = Array.isArray(updatedBlocksResponse)
    ? updatedBlocksResponse
    : ((updatedBlocksResponse as { items?: unknown[] }).items as Array<{
        label?: string;
        value?: string;
      }>) || [];

  const systemBlockHashes: Record<string, string> = {};
  const systemFileHashes: Record<string, string> = {};
  const userBlockHashes: Record<string, string> = {};
  const userFileHashes: Record<string, string> = {};

  for (const block of updatedBlocks.filter(
    (b: { label?: string }) => b.label && b.label !== "memory_filesystem",
  )) {
    systemBlockHashes[block.label as string] = hashContent(
      (block as { value?: string }).value || "",
    );
  }

  for (const [label, file] of updatedSystemFiles) {
    systemFileHashes[label] = hashContent(file.content);
  }

  for (const [label, blockId] of Object.entries(lastState.userBlockIds)) {
    try {
      const block = await client.blocks.retrieve(blockId);
      userBlockHashes[label] = hashContent(block.value || "");
    } catch {
      // Block gone
    }
  }

  for (const [label, file] of updatedUserFiles) {
    userFileHashes[label] = hashContent(file.content);
  }

  saveSyncState(
    {
      systemBlocks: systemBlockHashes,
      systemFiles: systemFileHashes,
      userBlocks: userBlockHashes,
      userFiles: userFileHashes,
      userBlockIds: lastState.userBlockIds,
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
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(
        "Error resolving conflicts:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    });
}
