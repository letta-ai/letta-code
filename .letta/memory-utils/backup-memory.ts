#!/usr/bin/env bun
/**
 * Backup Memory Blocks to Local Files
 * 
 * Exports all memory blocks from an agent to local files for checkpointing and editing.
 * Creates a timestamped backup directory with:
 * - Individual .md files for each memory block
 * - manifest.json with metadata
 * 
 * Usage:
 *   bun .letta/memory-utils/backup-memory.ts <agent-id> [backup-dir]
 * 
 * Example:
 *   bun .letta/memory-utils/backup-memory.ts agent-abc123
 *   bun .letta/memory-utils/backup-memory.ts $LETTA_PARENT_AGENT_ID .letta/backups/working
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getClient } from "../../src/agent/client";
import { settingsManager } from "../../src/settings-manager";

interface BackupManifest {
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

async function backupMemory(agentId: string, backupDir?: string): Promise<string> {
  await settingsManager.initialize();
  const client = await getClient();
  
  // Create backup directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultBackupDir = join(process.cwd(), ".letta", "backups", agentId, timestamp);
  const backupPath = backupDir || defaultBackupDir;
  
  await mkdir(backupPath, { recursive: true });
  
  console.log(`Backing up memory blocks for agent ${agentId}...`);
  console.log(`Backup location: ${backupPath}`);
  
  // Get all memory blocks
  const blocksResponse = await client.agents.blocks.list(agentId);
  const blocks = Array.isArray(blocksResponse) 
    ? blocksResponse 
    : (blocksResponse.items || blocksResponse.blocks || []);
  
  console.log(`Found ${blocks.length} memory blocks`);
  
  // Export each block to a file
  const manifest: BackupManifest = {
    agent_id: agentId,
    timestamp: new Date().toISOString(),
    backup_path: backupPath,
    blocks: [],
  };
  
  for (const block of blocks) {
    const label = block.label || `block-${block.id}`;
    const filename = `${label}.md`;
    const filepath = join(backupPath, filename);
    
    // Write block content to file
    const content = block.value || "";
    await writeFile(filepath, content, "utf-8");
    
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
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`  ✓ manifest.json`);
  
  console.log(`\n✅ Backup complete: ${backupPath}`);
  return backupPath;
}

// CLI Entry Point
if (import.meta.main) {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
Usage: bun .letta/memory-utils/backup-memory.ts <agent-id> [backup-dir]

Arguments:
  agent-id     Agent ID to backup (can use $LETTA_PARENT_AGENT_ID)
  backup-dir   Optional custom backup directory
               Default: .letta/backups/<agent-id>/<timestamp>

Examples:
  bun .letta/memory-utils/backup-memory.ts agent-abc123
  bun .letta/memory-utils/backup-memory.ts $LETTA_PARENT_AGENT_ID
  bun .letta/memory-utils/backup-memory.ts agent-abc123 .letta/backups/working
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
      console.error("Error backing up memory:", error.message);
      process.exit(1);
    });
}

export { backupMemory, type BackupManifest };
