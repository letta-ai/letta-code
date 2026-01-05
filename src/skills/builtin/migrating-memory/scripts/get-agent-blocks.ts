#!/usr/bin/env npx tsx
/**
 * Get Agent Blocks - Retrieves memory blocks from a specific agent
 *
 * This script is standalone and can be run outside the CLI process.
 * It reads auth from LETTA_API_KEY env var or ~/.letta/settings.json.
 *
 * Usage:
 *   npx tsx get-agent-blocks.ts --agent-id <agent-id>
 *
 * Output:
 *   Raw API response from GET /v1/agents/{id}/core-memory/blocks
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
 * Create a Letta client with auth from env/settings
 */
function createClient(): LettaClient {
  return new Letta({ apiKey: getApiKey() });
}

/**
 * Get memory blocks for a specific agent
 * @param client - Letta client instance
 * @param agentId - The agent ID to get blocks from
 * @returns Array of block objects from the API
 */
export async function getAgentBlocks(
  client: LettaClient,
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

// CLI entry point - check if this file is being run directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  (async () => {
    try {
      const { agentId } = parseArgs(process.argv.slice(2));
      const client = createClient();
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
          "\nUsage: npx tsx get-agent-blocks.ts --agent-id <agent-id>",
        );
      }
      process.exit(1);
    }
  })();
}
