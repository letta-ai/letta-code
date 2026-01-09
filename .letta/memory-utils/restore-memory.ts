#!/usr/bin/env bun
/**
 * Restore Memory Blocks from Local Files
 * 
 * Imports memory blocks from local files back into an agent.
 * Reads files from a backup directory and updates the agent's memory blocks.
 * 
 * Usage:
 *   bun .letta/memory-utils/restore-memory.ts <agent-id> <backup-dir>
 * 
 * Example:
 *   bun .letta/memory-utils/restore-memory.ts agent-abc123 .letta/backups/working
 *   bun .letta/memory-utils/restore-memory.ts $LETTA_PARENT_AGENT_ID .letta/backups/working
 */

import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { getClient } from "../../src/agent/client";
import { settingsManager } from "../../src/settings-manager";
import type { BackupManifest } from "./backup-memory";

async function restoreMemory(
  agentId: string,
  backupDir: string,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  await settingsManager.initialize();
  const client = await getClient();
  
  console.log(`Restoring memory blocks for agent ${agentId}...`);
  console.log(`Source: ${backupDir}`);
  
  if (options.dryRun) {
    console.log("⚠️  DRY RUN MODE - No changes will be made\n");
  }
  
  // Read manifest
  const manifestPath = join(backupDir, "manifest.json");
  let manifest: BackupManifest | null = null;
  
  try {
    const manifestContent = await readFile(manifestPath, "utf-8");
    manifest = JSON.parse(manifestContent);
    console.log(`Loaded manifest (${manifest.blocks.length} blocks)\n`);
  } catch (error) {
    console.warn("Warning: No manifest.json found, will scan directory for .md files");
  }
  
  // Get current agent blocks
  const blocksResponse = await client.agents.blocks.list(agentId);
  const currentBlocks = Array.isArray(blocksResponse) 
    ? blocksResponse 
    : (blocksResponse.items || blocksResponse.blocks || []);
  const blocksByLabel = new Map(currentBlocks.map((b) => [b.label, b]));
  
  // Determine which files to restore
  let filesToRestore: Array<{ label: string; filename: string; blockId?: string }> = [];
  
  if (manifest) {
    // Use manifest
    filesToRestore = manifest.blocks.map((b) => ({
      label: b.label,
      filename: b.filename,
      blockId: b.id,
    }));
  } else {
    // Scan directory for .md files
    const files = await readdir(backupDir);
    filesToRestore = files
      .filter((f) => extname(f) === ".md")
      .map((f) => ({
        label: f.replace(/\.md$/, ""),
        filename: f,
      }));
  }
  
  console.log(`Found ${filesToRestore.length} files to restore\n`);
  
  // Detect blocks to delete (exist on agent but not in backup)
  const backupLabels = new Set(filesToRestore.map((f) => f.label));
  const blocksToDelete = currentBlocks.filter((b) => !backupLabels.has(b.label));
  
  // Restore each block
  let updated = 0;
  let created = 0;
  let skipped = 0;
  let deleted = 0;
  
  // Track new blocks for later confirmation
  const blocksToCreate: Array<{ label: string; value: string; description: string }> = [];
  
  for (const { label, filename } of filesToRestore) {
    const filepath = join(backupDir, filename);
    
    try {
      const newValue = await readFile(filepath, "utf-8");
      const existingBlock = blocksByLabel.get(label);
      
      if (existingBlock) {
        // Update existing block
        const unchanged = existingBlock.value === newValue;
        
        if (unchanged) {
          console.log(`  ⏭️  ${label} - unchanged, skipping`);
          skipped++;
          continue;
        }
        
        if (!options.dryRun) {
          await client.agents.blocks.update(label, {
            agent_id: agentId,
            value: newValue,
          });
        }
        
        const oldLen = existingBlock.value?.length || 0;
        const newLen = newValue.length;
        const diff = newLen - oldLen;
        const diffStr = diff > 0 ? `+${diff}` : `${diff}`;
        
        console.log(`  ✓ ${label} - updated (${oldLen} -> ${newLen} chars, ${diffStr})`);
        updated++;
      } else {
        // New block - collect for later confirmation
        console.log(`  ➕ ${label} - new block (${newValue.length} chars)`);
        blocksToCreate.push({
          label,
          value: newValue,
          description: `Memory block: ${label}`,
        });
      }
    } catch (error) {
      console.error(`  ❌ ${label} - error: ${error.message}`);
    }
  }
  
  // Handle new blocks (exist in backup but not on agent)
  if (blocksToCreate.length > 0) {
    console.log(`\n➕ Found ${blocksToCreate.length} new block(s) to create:`);
    for (const block of blocksToCreate) {
      console.log(`    - ${block.label} (${block.value.length} chars)`);
    }
    
    if (!options.dryRun) {
      console.log(`\nThese blocks will be CREATED on the agent.`);
      console.log(`Press Ctrl+C to cancel, or press Enter to confirm creation...`);
      
      // Wait for user confirmation
      await new Promise<void>((resolve) => {
        process.stdin.once('data', () => resolve());
      });
      
      console.log();
      for (const block of blocksToCreate) {
        try {
          // Create the block
          const createdBlock = await client.blocks.create({
            label: block.label,
            value: block.value,
            description: block.description,
            limit: 20000,
          });
          
          if (!createdBlock.id) {
            throw new Error(`Created block ${block.label} has no ID`);
          }
          
          // Attach the newly created block to the agent
          await client.agents.blocks.attach(createdBlock.id, {
            agent_id: agentId,
          });
          
          console.log(`  ✅ ${block.label} - created and attached`);
          created++;
        } catch (error) {
          console.error(`  ❌ ${block.label} - error creating: ${error.message}`);
        }
      }
    } else {
      console.log(`\n(Would create these blocks if not in dry-run mode)`);
    }
  }
  
  // Handle deletions (blocks that exist on agent but not in backup)
  if (blocksToDelete.length > 0) {
    console.log(`\n⚠️  Found ${blocksToDelete.length} block(s) that were removed from backup:`);
    for (const block of blocksToDelete) {
      console.log(`    - ${block.label}`);
    }
    
    if (!options.dryRun) {
      console.log(`\nThese blocks will be DELETED from the agent.`);
      console.log(`Press Ctrl+C to cancel, or press Enter to confirm deletion...`);
      
      // Wait for user confirmation
      await new Promise<void>((resolve) => {
        process.stdin.once('data', () => resolve());
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
          console.error(`  ❌ ${block.label} - error deleting: ${error.message}`);
        }
      }
    } else {
      console.log(`\n(Would delete these blocks if not in dry-run mode)`);
    }
  }
  
  console.log(`\n📊 Summary:`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Created: ${created}`);
  console.log(`   Deleted: ${deleted}`);
  
  if (options.dryRun) {
    console.log(`\n⚠️  DRY RUN - No changes were made`);
    console.log(`   Run without --dry-run to apply changes`);
  } else {
    console.log(`\n✅ Restore complete`);
  }
}

// CLI Entry Point
if (import.meta.main) {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
Usage: bun .letta/memory-utils/restore-memory.ts <agent-id> <backup-dir> [options]

Arguments:
  agent-id     Agent ID to restore to (can use $LETTA_PARENT_AGENT_ID)
  backup-dir   Backup directory containing memory block files

Options:
  --dry-run    Preview changes without applying them

Examples:
  bun .letta/memory-utils/restore-memory.ts agent-abc123 .letta/backups/working
  bun .letta/memory-utils/restore-memory.ts $LETTA_PARENT_AGENT_ID .letta/backups/working
  bun .letta/memory-utils/restore-memory.ts agent-abc123 .letta/backups/working --dry-run
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
  
  restoreMemory(agentId, backupDir, { dryRun })
    .catch((error) => {
      console.error("Error restoring memory:", error.message);
      process.exit(1);
    });
}

export { restoreMemory };
