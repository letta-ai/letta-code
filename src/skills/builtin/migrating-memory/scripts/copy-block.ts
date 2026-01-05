#!/usr/bin/env npx tsx
/**
 * Copy Block - Copies a memory block to create a new independent block for the current agent
 *
 * This script is standalone and can be run outside the CLI process.
 * It reads auth from LETTA_API_KEY env var or ~/.letta/settings.json.
 * It reads agent ID from LETTA_AGENT_ID env var or --agent-id arg.
 *
 * Usage:
 *   npx tsx copy-block.ts --block-id <block-id> [--label <new-label>] [--agent-id <agent-id>]
 *
 * Options:
 *   --label      Override the block label (required if you already have a block with that label)
 *   --agent-id   Target agent ID (overrides LETTA_AGENT_ID env var)
 *
 * This creates a new block with the same content as the source block,
 * then attaches it to the current agent. Changes to the new block
 * won't affect the original.
 *
 * Output:
 *   Raw API response from each step (retrieve, create, attach)
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

// Use createRequire for @letta-ai/letta-client so NODE_PATH is respected
// (ES module imports don't respect NODE_PATH, but require does)
const require = createRequire(import.meta.url);
const Letta = require("@letta-ai/letta-client")
  .default as typeof import("@letta-ai/letta-client").default;
type LettaClient = InstanceType<typeof Letta>;

interface CopyBlockResult {
  sourceBlock: Awaited<ReturnType<LettaClient["blocks"]["retrieve"]>>;
  newBlock: Awaited<ReturnType<LettaClient["blocks"]["create"]>>;
  attachResult: Awaited<ReturnType<LettaClient["agents"]["blocks"]["attach"]>>;
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
 * Get agent ID from CLI arg, env var, or throw
 */
function getAgentId(cliArg?: string): string {
  if (cliArg) return cliArg;
  if (process.env.LETTA_AGENT_ID) {
    return process.env.LETTA_AGENT_ID;
  }
  throw new Error(
    "No agent ID provided. Use --agent-id or ensure LETTA_AGENT_ID env var is set.",
  );
}

/**
 * Create a Letta client with auth from env/settings
 */
function createClient(): LettaClient {
  return new Letta({ apiKey: getApiKey() });
}

/**
 * Copy a block's content to a new block and attach to the current agent
 * @param client - Letta client instance
 * @param blockId - The source block ID to copy from
 * @param options - Optional settings: labelOverride, targetAgentId
 * @returns Object containing source block, new block, and attach result
 */
export async function copyBlock(
  client: LettaClient,
  blockId: string,
  options?: { labelOverride?: string; targetAgentId?: string },
): Promise<CopyBlockResult> {
  // Get current agent ID (the agent calling this script) or use provided ID
  const currentAgentId = getAgentId(options?.targetAgentId);

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

function parseArgs(args: string[]): {
  blockId: string;
  label?: string;
  agentId?: string;
} {
  const blockIdIndex = args.indexOf("--block-id");
  const labelIndex = args.indexOf("--label");
  const agentIdIndex = args.indexOf("--agent-id");

  if (blockIdIndex === -1 || blockIdIndex + 1 >= args.length) {
    throw new Error("Missing required argument: --block-id <block-id>");
  }

  return {
    blockId: args[blockIdIndex + 1] as string,
    label:
      labelIndex !== -1 && labelIndex + 1 < args.length
        ? (args[labelIndex + 1] as string)
        : undefined,
    agentId:
      agentIdIndex !== -1 && agentIdIndex + 1 < args.length
        ? (args[agentIdIndex + 1] as string)
        : undefined,
  };
}

// CLI entry point - check if this file is being run directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  (async () => {
    try {
      const { blockId, label, agentId } = parseArgs(process.argv.slice(2));
      const client = createClient();
      const result = await copyBlock(client, blockId, {
        labelOverride: label,
        targetAgentId: agentId,
      });
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
          "\nUsage: npx tsx copy-block.ts --block-id <block-id> [--label <new-label>] [--agent-id <agent-id>]",
        );
      }
      process.exit(1);
    }
  })();
}
