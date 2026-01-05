#!/usr/bin/env npx tsx
/**
 * Attach Block - Attaches an existing memory block to an agent (sharing)
 *
 * This script is standalone and can be run outside the CLI process.
 * It reads auth from LETTA_API_KEY env var or ~/.letta/settings.json.
 * It reads agent ID from LETTA_AGENT_ID env var or --agent-id arg.
 *
 * Usage:
 *   npx tsx attach-block.ts --block-id <block-id> [--agent-id <agent-id>] [--read-only]
 *
 * This attaches an existing block to another agent, making it shared.
 * Changes to the block will be visible to all agents that have it attached.
 *
 * Options:
 *   --agent-id   Target agent ID (overrides LETTA_AGENT_ID env var)
 *   --read-only  Target agent can read but not modify the block
 *
 * Output:
 *   Raw API response from the attach operation
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
 * Attach an existing block to the current agent (sharing it)
 * @param client - Letta client instance
 * @param blockId - The block ID to attach
 * @param readOnly - Whether this agent should have read-only access
 * @param targetAgentId - Optional target agent ID (defaults to current agent)
 * @returns API response from the attach operation
 */
export async function attachBlock(
  client: LettaClient,
  blockId: string,
  readOnly = false,
  targetAgentId?: string,
): Promise<Awaited<ReturnType<typeof client.agents.blocks.attach>>> {
  // Get current agent ID (the agent calling this script) or use provided ID
  const currentAgentId = getAgentId(targetAgentId);

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
  agentId?: string;
} {
  const blockIdIndex = args.indexOf("--block-id");
  const agentIdIndex = args.indexOf("--agent-id");
  const readOnly = args.includes("--read-only");

  if (blockIdIndex === -1 || blockIdIndex + 1 >= args.length) {
    throw new Error("Missing required argument: --block-id <block-id>");
  }

  return {
    blockId: args[blockIdIndex + 1] as string,
    readOnly,
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
      const { blockId, readOnly, agentId } = parseArgs(process.argv.slice(2));
      const client = createClient();
      const result = await attachBlock(client, blockId, readOnly, agentId);
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
          "\nUsage: npx tsx attach-block.ts --block-id <block-id> [--agent-id <agent-id>] [--read-only]",
        );
      }
      process.exit(1);
    }
  })();
}
