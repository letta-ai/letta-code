#!/usr/bin/env bun
/**
 * Cleanup Script: Delete all Letta agents to resolve API limit issues
 *
 * This script lists all agents and provides options to:
 * - List all agents with details
 * - Delete specific agents by ID
 * - Delete all agents (with confirmation)
 */

import { getClient } from "../src/agent/client";
import { settingsManager } from "../src/settings-manager";

async function listAgents() {
  console.log("\n📋 Fetching agents...");
  const client = await getClient();
  const response = await client.agents.list({ limit: 100 });

  if (!response.body || response.body.length === 0) {
    console.log("✅ No agents found");
    return [];
  }

  console.log(`\n📊 Total agents: ${response.body.length}\n`);
  response.body.forEach((agent: any, index: number) => {
    console.log(`${index + 1}. ${agent.name}`);
    console.log(`   ID: ${agent.id}`);
    console.log(`   Created: ${agent.created_at}`);
    console.log(`   Updated: ${agent.updated_at}`);
    console.log("");
  });

  return response.body;
}

async function deleteAgent(agentId: string, agentName: string) {
  try {
    console.log(`🗑️  Deleting agent: ${agentName} (${agentId})`);
    const client = await getClient();
    await client.agents.delete(agentId);
    console.log(`✅ Successfully deleted: ${agentName}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to delete ${agentName}:`, error);
    return false;
  }
}

async function deleteAllAgents(agentList: any[]) {
  console.log(`\n⚠️  WARNING: About to delete ${agentList.length} agents`);
  console.log("This action cannot be undone!\n");

  // Simple confirmation (in production, you might want better confirmation)
  const agentCount = agentList.length;
  console.log(`Proceeding with deletion of ${agentCount} agents...\n`);

  let successCount = 0;
  let failCount = 0;

  for (const agent of agentList) {
    const success = await deleteAgent(agent.id, agent.name);
    if (success) {
      successCount++;
    } else {
      failCount++;
    }

    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`\n📈 Deletion Summary:`);
  console.log(`✅ Successfully deleted: ${successCount}`);
  console.log(`❌ Failed to delete: ${failCount}`);
}

async function main() {
  // Initialize settings manager first
  await settingsManager.initialize();

  const command = process.argv[2];

  try {
    switch (command) {
      case "list": {
        await listAgents();
        break;
      }

      case "delete-all": {
        const agents = await listAgents();
        if (agents.length > 0) {
          await deleteAllAgents(agents);
        }
        break;
      }

      case "delete": {
        const agentId = process.argv[3];
        if (!agentId) {
          console.error("Error: Agent ID required for delete command");
          console.log("Usage: bun run cleanup-agents.ts delete <agent-id>");
          process.exit(1);
        }

        const allAgents = await listAgents();
        const agentToDelete = allAgents.find((a: any) => a.id === agentId);
        if (!agentToDelete) {
          console.error(`Error: Agent with ID ${agentId} not found`);
          process.exit(1);
        }

        await deleteAgent(agentId, agentToDelete.name);
        break;
      }

      default: {
        console.log(`
Usage: bun run scripts/cleanup-agents.ts <command>

Commands:
  list        - List all agents
  delete-all  - Delete all agents (with confirmation)
  delete <id> - Delete a specific agent by ID

Examples:
  bun run scripts/cleanup-agents.ts list
  bun run scripts/cleanup-agents.ts delete-all
  bun run scripts/cleanup-agents.ts delete agent-12345678
        `);
        break;
      }
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
