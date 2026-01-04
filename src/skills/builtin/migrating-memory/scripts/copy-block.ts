#!/usr/bin/env npx ts-node
/**
 * Copy Block - Copies a memory block to create a new independent block for the current agent
 *
 * Usage:
 *   npx ts-node copy-block.ts --block-id <block-id> [--label <new-label>]
 *
 * Options:
 *   --label    Override the block label (required if you already have a block with that label)
 *
 * This creates a new block with the same content as the source block,
 * then attaches it to the current agent. Changes to the new block
 * won't affect the original.
 *
 * Output:
 *   Raw API response from each step (retrieve, create, attach)
 */

import type Letta from "@letta-ai/letta-client";
import { getClient } from "../../../../agent/client";
import { getCurrentAgentId } from "../../../../agent/context";
import { settingsManager } from "../../../../settings-manager";

interface CopyBlockResult {
  sourceBlock: Awaited<ReturnType<typeof Letta.prototype.blocks.retrieve>>;
  newBlock: Awaited<ReturnType<typeof Letta.prototype.blocks.create>>;
  attachResult: Awaited<
    ReturnType<typeof Letta.prototype.agents.blocks.attach>
  >;
}

/**
 * Copy a block's content to a new block and attach to the current agent
 * @param client - Letta client instance
 * @param blockId - The source block ID to copy from
 * @param options - Optional settings: labelOverride, targetAgentId
 * @returns Object containing source block, new block, and attach result
 */
export async function copyBlock(
  client: Letta,
  blockId: string,
  options?: { labelOverride?: string; targetAgentId?: string },
): Promise<CopyBlockResult> {
  // Get current agent ID (the agent calling this script) or use provided ID
  const currentAgentId = options?.targetAgentId ?? getCurrentAgentId();

  // 1. Get source block details
  const sourceBlock = await client.blocks.retrieve(blockId);

  // 2. Create new block with same content (optionally override label)
  const newBlock = await client.blocks.create({
    label: options?.labelOverride || sourceBlock.label || "migrated-block",
    value: sourceBlock.value,
    description: sourceBlock.description || undefined,
    limit: sourceBlock.limit,
  });

  // 3. Attach new block to current agent
  const attachResult = await client.agents.blocks.attach(newBlock.id, {
    agent_id: currentAgentId,
  });

  return { sourceBlock, newBlock, attachResult };
}

function parseArgs(args: string[]): { blockId: string; label?: string } {
  const blockIdIndex = args.indexOf("--block-id");
  const labelIndex = args.indexOf("--label");

  if (blockIdIndex === -1 || blockIdIndex + 1 >= args.length) {
    throw new Error("Missing required argument: --block-id <block-id>");
  }

  return {
    blockId: args[blockIdIndex + 1] as string,
    label:
      labelIndex !== -1 && labelIndex + 1 < args.length
        ? (args[labelIndex + 1] as string)
        : undefined,
  };
}

// CLI entry point
if (require.main === module) {
  (async () => {
    try {
      const { blockId, label } = parseArgs(process.argv.slice(2));
      await settingsManager.initialize();
      const client = await getClient();
      const result = await copyBlock(client, blockId, { labelOverride: label });
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
          "\nUsage: npx ts-node copy-block.ts --block-id <block-id> [--label <new-label>]",
        );
      }
      process.exit(1);
    }
  })();
}
