#!/usr/bin/env npx ts-node
/**
 * Get Agent Blocks - Retrieves memory blocks from a specific agent
 *
 * Usage:
 *   npx ts-node get-agent-blocks.ts --agent-id <agent-id>
 *
 * Output:
 *   Raw API response from GET /v1/agents/{id}/core-memory/blocks
 */

import type Letta from "@letta-ai/letta-client";
import { getClient } from "../../../../agent/client";
import { settingsManager } from "../../../../settings-manager";

/**
 * Get memory blocks for a specific agent
 * @param client - Letta client instance
 * @param agentId - The agent ID to get blocks from
 * @returns Array of block objects from the API
 */
export async function getAgentBlocks(
  client: Letta,
  agentId: string,
): Promise<Awaited<ReturnType<typeof client.agents.blocks.list>>> {
  return await client.agents.blocks.list(agentId);
}

function parseArgs(args: string[]): { agentId: string } {
  const agentIdIndex = args.indexOf("--agent-id");
  if (agentIdIndex === -1 || agentIdIndex + 1 >= args.length) {
    throw new Error("Missing required argument: --agent-id <agent-id>");
  }
  return { agentId: args[agentIdIndex + 1] as string };
}

// CLI entry point
if (require.main === module) {
  (async () => {
    try {
      const { agentId } = parseArgs(process.argv.slice(2));
      await settingsManager.initialize();
      const client = await getClient();
      const result = await getAgentBlocks(client, agentId);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      if (
        error instanceof Error &&
        error.message.includes("Missing required argument")
      ) {
        console.error(
          "\nUsage: npx ts-node get-agent-blocks.ts --agent-id <agent-id>",
        );
      }
      process.exit(1);
    }
  })();
}
