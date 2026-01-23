#!/usr/bin/env npx tsx
/**
 * Restore Memory Blocks from Local Files
 *
 * Imports memory blocks from local files back into an agent.
 * Reads files from a backup directory and updates the agent's memory blocks.
 *
 * This script is standalone and can be run outside the CLI process.
 * It reads auth from LETTA_API_KEY env var or ~/.letta/settings.json.
 *
 * Usage:
 *   npx tsx restore-memory.ts <agent-id> <backup-dir> [options]
 *
 * Example:
 *   npx tsx restore-memory.ts agent-abc123 .letta/backups/working
 *   npx tsx restore-memory.ts $LETTA_AGENT_ID .letta/backups/working --dry-run
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { extname, join, relative } from "node:path";

import type { BackupManifest } from "./backup-memory";

// Use createRequire for @letta-ai/letta-client so NODE_PATH is respected
// (ES module imports don't respect NODE_PATH, but require does)
const require = createRequire(import.meta.url);
const Letta = require("@letta-ai/letta-client")
  .default as typeof import("@letta-ai/letta-client").default;
type LettaClient = InstanceType<typeof Letta>;

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
  return new Letta({ apiKey: getApiKey() });
}

/**
 * Recursively scan directory for .md files
 * Returns array of relative file paths from baseDir
 */
function scanMdFiles(dir: string, baseDir: string = dir): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Recursively scan subdirectory
      results.push(...scanMdFiles(fullPath, baseDir));
    } else if (stat.isFile() && extname(entry) === ".md") {
      // Convert to relative path from baseDir
      const relativePath = relative(baseDir, fullPath);
      results.push(relativePath);
    }
  }

  return results;
}

/**
 * Restore memory blocks from local files
 */
async function restoreMemory(
  agentId: string,
  backupDir: string,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  const client = createClient();

  console.log(`Restoring memory blocks for agent ${agentId}...`);
  console.log(`Source: ${backupDir}`);

  if (options.dryRun) {
    console.log("⚠️  DRY RUN MODE - No changes will be made\n");
  }

  // Read manifest for metadata only (block IDs)
  const manifestPath = join(backupDir, "manifest.json");
  let manifest: BackupManifest | null = null;

  try {
    const manifestContent = readFileSync(manifestPath, "utf-8");
    manifest = JSON.parse(manifestContent);
  } catch {
    // Manifest is optional
  }

  // Get current agent blocks
  const blocksResponse = await client.agents.blocks.list(agentId);
  const currentBlocks = Array.isArray(blocksResponse)
    ? blocksResponse
    : (blocksResponse as { items?: unknown[] }).items ||
      (blocksResponse as { blocks?: unknown[] }).blocks ||
      [];
  const blocksByLabel = new Map(
    (currentBlocks as Array<{ label: string; id: string; value?: string }>).map(
      (b) => [b.label, b],
    ),
  );

  // Always scan directory for .md files (manifest is only used for block IDs)
  const files = scanMdFiles(backupDir);
  console.log(`Scanned ${files.length} .md files\n`);
  const filesToRestore = files.map((relativePath) => {
    // Convert path like "A/B.md" to label "A/B"
    // Replace backslashes with forward slashes (Windows compatibility)
    const normalizedPath = relativePath.replace(/\\/g, "/");
    const label = normalizedPath.replace(/\.md$/, "");
    // Look up block ID from manifest if available
    const manifestBlock = manifest?.blocks.find((b) => b.label === label);
    return {
      label,
      filename: relativePath,
      blockId: manifestBlock?.id,
    };
  });



  // Detect blocks to delete (exist on agent but not in backup)
  const backupLabels = new Set(filesToRestore.map((f) => f.label));
  const blocksToDelete = (
    currentBlocks as Array<{ label: string; id: string }>
  ).filter((b) => !backupLabels.has(b.label));

  // Restore each block
  let updated = 0;
  let created = 0;
  let deleted = 0;



  for (const { label, filename } of filesToRestore) {
    const filepath = join(backupDir, filename);

    try {
      const newValue = readFileSync(filepath, "utf-8");
      const existingBlock = blocksByLabel.get(label);

      if (existingBlock) {
        // Update existing block (always update, even if unchanged)
        if (!options.dryRun) {
          await client.agents.blocks.update(label, {
            agent_id: agentId,
            value: newValue,
          });
        }

        const oldLen = existingBlock.value?.length || 0;
        const newLen = newValue.length;
        const unchanged = existingBlock.value === newValue;

        if (unchanged) {
          console.log(`  ✓ ${label} - restored (${newLen} chars, unchanged)`);
        } else {
          const diff = newLen - oldLen;
          const diffStr = diff > 0 ? `+${diff}` : `${diff}`;
          console.log(
            `  ✓ ${label} - restored (${oldLen} -> ${newLen} chars, ${diffStr})`,
          );
        }
        updated++;
      } else {
        // New block - create immediately
        if (!options.dryRun) {
          const createdBlock = await client.blocks.create({
            label,
            value: newValue,
            description: `Memory block: ${label}`,
            limit: 20000,
          });

          if (!createdBlock.id) {
            throw new Error(`Created block ${label} has no ID`);
          }

          await client.agents.blocks.attach(createdBlock.id, {
            agent_id: agentId,
          });
        }
        console.log(`  ✓ ${label} - created (${newValue.length} chars)`);
        created++;
      }
    } catch (error) {
      console.error(
        `  ❌ ${label} - error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Handle deletions (blocks that exist on agent but not in backup)
  if (blocksToDelete.length > 0) {
    console.log(
      `\n⚠️  Found ${blocksToDelete.length} block(s) that were removed from backup:`,
    );
    for (const block of blocksToDelete) {
      console.log(`    - ${block.label}`);
    }

    if (!options.dryRun) {
      console.log(`\nThese blocks will be DELETED from the agent.`);
      console.log(
        `Press Ctrl+C to cancel, or press Enter to confirm deletion...`,
      );

      // Wait for user confirmation
      await new Promise<void>((resolve) => {
        process.stdin.once("data", () => resolve());
      });

      console.log();
      for (const block of blocksToDelete) {
        try {
          await client.agents.blocks.detach(block.id, {
            agent_id: agentId,
          });
          console.log(`  🗑️  ${block.label} - deleted`);
          deleted++;
        } catch (error) {
          console.error(
            `  ❌ ${block.label} - error deleting: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } else {
      console.log(`\n(Would delete these blocks if not in dry-run mode)`);
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Restored: ${updated}`);
  console.log(`   Created: ${created}`);
  console.log(`   Deleted: ${deleted}`);

  if (options.dryRun) {
    console.log(`\n⚠️  DRY RUN - No changes were made`);
    console.log(`   Run without --dry-run to apply changes`);
  } else {
    console.log(`\n✅ Restore complete`);
  }
}

// CLI Entry Point - check if this file is being run directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
Usage: npx tsx restore-memory.ts <agent-id> <backup-dir> [options]

Arguments:
  agent-id     Agent ID to restore to (can use $LETTA_AGENT_ID)
  backup-dir   Backup directory containing memory block files

Options:
  --dry-run    Preview changes without applying them

Examples:
  npx tsx restore-memory.ts agent-abc123 .letta/backups/working
  npx tsx restore-memory.ts $LETTA_AGENT_ID .letta/backups/working
  npx tsx restore-memory.ts agent-abc123 .letta/backups/working --dry-run
    `);
    process.exit(0);
  }

  const agentId = args[0];
  const backupDir = args[1];
  const dryRun = args.includes("--dry-run");

  if (!agentId || !backupDir) {
    console.error("Error: agent-id and backup-dir are required");
    process.exit(1);
  }

  restoreMemory(agentId, backupDir, { dryRun }).catch((error) => {
    console.error(
      "Error restoring memory:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}

export { restoreMemory };
