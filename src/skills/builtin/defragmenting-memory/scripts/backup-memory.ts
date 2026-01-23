#!/usr/bin/env npx tsx
/**
 * Backup Memory Blocks to Local Files
 *
 * Exports all memory blocks from an agent to local files for checkpointing and editing.
 * Creates a timestamped backup directory with:
 * - Individual .md files for each memory block
 * - manifest.json with metadata
 *
 * This script is standalone and can be run outside the CLI process.
 * It reads auth from LETTA_API_KEY env var or ~/.letta/settings.json.
 *
 * Usage:
 *   npx tsx backup-memory.ts <agent-id> [backup-dir]
 *
 * Example:
 *   npx tsx backup-memory.ts agent-abc123
 *   npx tsx backup-memory.ts $LETTA_AGENT_ID .letta/backups/working
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Use createRequire for @letta-ai/letta-client so NODE_PATH is respected
// (ES module imports don't respect NODE_PATH, but require does)
const require = createRequire(import.meta.url);
const Letta = require("@letta-ai/letta-client")
  .default as typeof import("@letta-ai/letta-client").default;
type LettaClient = InstanceType<typeof Letta>;

export interface BackupManifest {
  agent_id: string;
  timestamp: string;
  backup_path: string;
  blocks: Array<{
    id: string;
    label: string;
    filename: string;
    limit: number;
    value_length: number;
  }>;
}

/**
 * Get API key from env var or settings file
 */
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

/**
 * Create a Letta client with auth from env/settings
 */
function createClient(): LettaClient {
  const baseUrl = process.env.LETTA_BASE_URL || "https://api.letta.com";
  return new Letta({ apiKey: getApiKey(), baseUrl });
}

/**
 * Backup memory blocks to local files
 */
async function backupMemory(
  agentId: string,
  backupDir?: string,
): Promise<string> {
  const client = createClient();

  // Create backup directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultBackupDir = join(
    process.cwd(),
    ".letta",
    "backups",
    agentId,
    timestamp,
  );
  const backupPath = backupDir || defaultBackupDir;

  mkdirSync(backupPath, { recursive: true });

  console.log(`Backing up memory blocks for agent ${agentId}...`);
  console.log(`Backup location: ${backupPath}`);

  // Get all memory blocks
  const blocksResponse = await client.agents.blocks.list(agentId);
  const blocks = Array.isArray(blocksResponse)
    ? blocksResponse
    : (blocksResponse as { items?: unknown[] }).items ||
      (blocksResponse as { blocks?: unknown[] }).blocks ||
      [];

  console.log(`Found ${blocks.length} memory blocks`);

  // Export each block to a file
  const manifest: BackupManifest = {
    agent_id: agentId,
    timestamp: new Date().toISOString(),
    backup_path: backupPath,
    blocks: [],
  };

  for (const block of blocks as Array<{
    id: string;
    label?: string;
    value?: string;
    limit?: number;
  }>) {
    const label = block.label || `block-${block.id}`;
    // For hierarchical labels like "A/B", create directory A/ with file B.md
    const filename = `${label}.md`;
    const filepath = join(backupPath, filename);

    // Create parent directories if label contains slashes
    const parentDir = dirname(filepath);
    if (parentDir !== backupPath) {
      mkdirSync(parentDir, { recursive: true });
    }

    // Write block content to file
    const content = block.value || "";
    writeFileSync(filepath, content, "utf-8");

    console.log(`  ✓ ${label} -> ${filename} (${content.length} chars)`);

    // Add to manifest
    manifest.blocks.push({
      id: block.id,
      label,
      filename,
      limit: block.limit || 0,
      value_length: content.length,
    });
  }

  // Write manifest
  const manifestPath = join(backupPath, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`  ✓ manifest.json`);

  console.log(`\n✅ Backup complete: ${backupPath}`);
  return backupPath;
}

// CLI Entry Point - check if this file is being run directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
Usage: npx tsx backup-memory.ts <agent-id> [backup-dir]

Arguments:
  agent-id     Agent ID to backup (can use $LETTA_AGENT_ID)
  backup-dir   Optional custom backup directory
               Default: .letta/backups/<agent-id>/<timestamp>

Examples:
  npx tsx backup-memory.ts agent-abc123
  npx tsx backup-memory.ts $LETTA_AGENT_ID
  npx tsx backup-memory.ts agent-abc123 .letta/backups/working
    `);
    process.exit(0);
  }

  const agentId = args[0];
  const backupDir = args[1];

  if (!agentId) {
    console.error("Error: agent-id is required");
    process.exit(1);
  }

  backupMemory(agentId, backupDir)
    .then((path) => {
      // Output just the path for easy capture in scripts
      console.log(path);
    })
    .catch((error) => {
      console.error(
        "Error backing up memory:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    });
}

export { backupMemory };
