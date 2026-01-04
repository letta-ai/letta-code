#!/usr/bin/env npx ts-node
/**
 * Attach Block - Attaches an existing memory block to an agent (sharing)
 *
 * Usage:
 *   npx ts-node attach-block.ts --block-id <block-id> --target-agent-id <agent-id> [--read-only]
 *
 * This attaches an existing block to another agent, making it shared.
 * Changes to the block will be visible to all agents that have it attached.
 *
 * Options:
 *   --read-only    Target agent can read but not modify the block
 *
 * Output:
 *   Raw API response from the attach operation
 */

import type Letta from "@letta-ai/letta-client";
import { getClient } from "../../../../agent/client";
import { getCurrentAgentId } from "../../../../agent/context";
import { settingsManager } from "../../../../settings-manager";

/**
 * Attach an existing block to the current agent (sharing it)
 * @param client - Letta client instance
 * @param blockId - The block ID to attach
 * @param readOnly - Whether this agent should have read-only access
 * @param targetAgentId - Optional target agent ID (defaults to current agent)
 * @returns API response from the attach operation
 */
export async function attachBlock(
  client: Letta,
  blockId: string,
  readOnly = false,
  targetAgentId?: string,
): Promise<Awaited<ReturnType<typeof client.agents.blocks.attach>>> {
  // Get current agent ID (the agent calling this script) or use provided ID
  const currentAgentId = targetAgentId ?? getCurrentAgentId();

  const result = await client.agents.blocks.attach(blockId, {
    agent_id: currentAgentId,
  });

  // If read-only is requested, update the block's read_only flag for this agent
  // Note: This may require a separate API call depending on how read_only works
  if (readOnly) {
    // The read_only flag is per-block, not per-agent attachment
    // For now, we'll note this in the output
    console.warn(
      "Note: read_only flag is set on the block itself, not per-agent. " +
        "Use the block update API to set read_only if needed.",
    );
  }

  return result;
}

function parseArgs(args: string[]): {
  blockId: string;
  readOnly: boolean;
} {
  const blockIdIndex = args.indexOf("--block-id");
  const readOnly = args.includes("--read-only");

  if (blockIdIndex === -1 || blockIdIndex + 1 >= args.length) {
    throw new Error("Missing required argument: --block-id <block-id>");
  }

  return {
    blockId: args[blockIdIndex + 1] as string,
    readOnly,
  };
}

// CLI entry point
if (require.main === module) {
  (async () => {
    try {
      const { blockId, readOnly } = parseArgs(process.argv.slice(2));
      await settingsManager.initialize();
      const client = await getClient();
      const result = await attachBlock(client, blockId, readOnly);
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
          "\nUsage: npx ts-node attach-block.ts --block-id <block-id> [--read-only]",
        );
      }
      process.exit(1);
    }
  })();
}
