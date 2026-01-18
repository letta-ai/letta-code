#!/usr/bin/env bun
/**
 * Attach Block - Attaches an existing memory block to an agent (sharing)
 *
 * This script is standalone and can be run outside the CLI process.
 * It reads auth from LETTA_API_KEY env var or ~/.letta/settings.json.
 * It reads agent ID from LETTA_AGENT_ID env var or --agent-id arg.
 *
 * Usage:
 *   bun attach-block.ts --block-id <block-id> [--agent-id <agent-id>] [--read-only] [--override]
 *
 * This attaches an existing block to another agent, making it shared.
 * Changes to the block will be visible to all agents that have it attached.
 *
 * Options:
 *   --agent-id   Target agent ID (overrides LETTA_AGENT_ID env var)
 *   --read-only  Target agent can read but not modify the block
 *   --override   If you already have a block with the same label, detach it first
 *                (on error, the original block is reattached)
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

interface AttachBlockResult {
  attachResult: Awaited<ReturnType<LettaClient["agents"]["blocks"]["attach"]>>;
  detachedBlock?: Awaited<ReturnType<LettaClient["blocks"]["retrieve"]>>;
}

/**
 * Attach an existing block to the current agent (sharing it)
 * @param client - Letta client instance
 * @param blockId - The block ID to attach
 * @param options - readOnly, targetAgentId, override (detach existing block with same label)
 * @returns API response from the attach operation
 */
export async function attachBlock(
  client: LettaClient,
  blockId: string,
  options?: { readOnly?: boolean; targetAgentId?: string; override?: boolean },
): Promise<AttachBlockResult> {
  const currentAgentId = getAgentId(options?.targetAgentId);
  let detachedBlock:
    | Awaited<ReturnType<LettaClient["blocks"]["retrieve"]>>
    | undefined;

  // If override is requested, check for existing block with same label and detach it
  if (options?.override) {
    // Get the block we're trying to attach to find its label
    const sourceBlock = await client.blocks.retrieve(blockId);
    const sourceLabel = sourceBlock.label;

    // Get current agent's blocks to check for label conflict
    const currentBlocksResponse =
      await client.agents.blocks.list(currentAgentId);
    // The response may be paginated or an array depending on SDK version
    const currentBlocks = Array.isArray(currentBlocksResponse)
      ? currentBlocksResponse
      : (currentBlocksResponse as { items?: unknown[] }).items || [];
    const conflictingBlock = currentBlocks.find(
      (b: { label?: string }) => b.label === sourceLabel,
    );

    if (conflictingBlock) {
      console.error(
        `Detaching existing block with label "${sourceLabel}" (${conflictingBlock.id})...`,
      );
      detachedBlock = conflictingBlock;
      try {
        await client.agents.blocks.detach(conflictingBlock.id, {
          agent_id: currentAgentId,
        });
      } catch (detachError) {
        throw new Error(
          `Failed to detach existing block "${sourceLabel}": ${detachError instanceof Error ? detachError.message : String(detachError)}`,
        );
      }
    }
  }

  // Attempt to attach the new block
  let attachResult: Awaited<ReturnType<typeof client.agents.blocks.attach>>;
  try {
    attachResult = await client.agents.blocks.attach(blockId, {
      agent_id: currentAgentId,
    });
  } catch (attachError) {
    // If attach failed and we detached a block, try to reattach it
    if (detachedBlock) {
      console.error(
        `Attach failed, reattaching original block "${detachedBlock.label}"...`,
      );
      try {
        await client.agents.blocks.attach(detachedBlock.id, {
          agent_id: currentAgentId,
        });
        console.error("Original block reattached successfully.");
      } catch {
        console.error(
          `WARNING: Failed to reattach original block! Block ID: ${detachedBlock.id}`,
        );
      }
    }
    throw attachError;
  }

  // If read-only is requested, note the limitation
  if (options?.readOnly) {
    console.warn(
      "Note: read_only flag is set on the block itself, not per-agent. " +
        "Use the block update API to set read_only if needed.",
    );
  }

  return { attachResult, detachedBlock };
}

function parseArgs(args: string[]): {
  blockId: string;
  readOnly: boolean;
  override: boolean;
  agentId?: string;
} {
  const blockIdIndex = args.indexOf("--block-id");
  const agentIdIndex = args.indexOf("--agent-id");
  const readOnly = args.includes("--read-only");
  const override = args.includes("--override");

  if (blockIdIndex === -1 || blockIdIndex + 1 >= args.length) {
    throw new Error("Missing required argument: --block-id <block-id>");
  }

  return {
    blockId: args[blockIdIndex + 1] as string,
    readOnly,
    override,
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
      const { blockId, readOnly, override, agentId } = parseArgs(
        process.argv.slice(2),
      );
      const client = createClient();
      const result = await attachBlock(client, blockId, {
        readOnly,
        override,
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
          "\nUsage: bun attach-block.ts --block-id <block-id> [--agent-id <agent-id>] [--read-only] [--override]",
        );
      }
      process.exit(1);
    }
  })();
}
