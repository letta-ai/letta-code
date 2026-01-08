#!/usr/bin/env bun
/**
 * Find Agents - Search for agents with various filters
 *
 * This script is standalone and can be run outside the CLI process.
 * It reads auth from LETTA_API_KEY env var or ~/.letta/settings.json.
 *
 * Usage:
 *   bun find-agents.ts [options]
 *
 * Options:
 *   --name <name>         Exact name match
 *   --query <text>        Fuzzy search by name
 *   --tags <tag1,tag2>    Filter by tags (comma-separated)
 *   --match-all-tags      Require ALL tags (default: ANY)
 *   --include-blocks      Include agent.blocks in response
 *   --limit <n>           Max results (default: 20)
 *
 * Output:
 *   Raw API response from GET /v1/agents
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

interface FindAgentsOptions {
  name?: string;
  query?: string;
  tags?: string[];
  matchAllTags?: boolean;
  includeBlocks?: boolean;
  limit?: number;
}

/**
 * Get API key from env var or settings file
 */
function getApiKey(): string {
  // First check env var (set by CLI's getShellEnv)
  if (process.env.LETTA_API_KEY) {
    return process.env.LETTA_API_KEY;
  }

  // Fall back to settings file
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
 * Find agents matching the given criteria
 * @param client - Letta client instance
 * @param options - Search options
 * @returns Array of agent objects from the API
 */
export async function findAgents(
  client: LettaClient,
  options: FindAgentsOptions = {},
): Promise<Awaited<ReturnType<typeof client.agents.list>>> {
  const params: Parameters<typeof client.agents.list>[0] = {
    limit: options.limit ?? 20,
  };

  if (options.name) {
    params.name = options.name;
  }

  if (options.query) {
    params.query_text = options.query;
  }

  if (options.tags && options.tags.length > 0) {
    params.tags = options.tags;
    if (options.matchAllTags) {
      params.match_all_tags = true;
    }
  }

  if (options.includeBlocks) {
    params.include = ["agent.blocks"];
  }

  return await client.agents.list(params);
}

function parseArgs(args: string[]): FindAgentsOptions {
  const options: FindAgentsOptions = {};

  const nameIndex = args.indexOf("--name");
  if (nameIndex !== -1 && nameIndex + 1 < args.length) {
    options.name = args[nameIndex + 1];
  }

  const queryIndex = args.indexOf("--query");
  if (queryIndex !== -1 && queryIndex + 1 < args.length) {
    options.query = args[queryIndex + 1];
  }

  const tagsIndex = args.indexOf("--tags");
  if (tagsIndex !== -1 && tagsIndex + 1 < args.length) {
    options.tags = args[tagsIndex + 1]?.split(",").map((t) => t.trim());
  }

  if (args.includes("--match-all-tags")) {
    options.matchAllTags = true;
  }

  if (args.includes("--include-blocks")) {
    options.includeBlocks = true;
  }

  const limitIndex = args.indexOf("--limit");
  if (limitIndex !== -1 && limitIndex + 1 < args.length) {
    const limit = Number.parseInt(args[limitIndex + 1] as string, 10);
    if (!Number.isNaN(limit)) {
      options.limit = limit;
    }
  }

  return options;
}

// CLI entry point - check if this file is being run directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  (async () => {
    try {
      const options = parseArgs(process.argv.slice(2));
      const client = createClient();
      const result = await findAgents(client, options);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      console.error(`
Usage: bun find-agents.ts [options]

Options:
  --name <name>         Exact name match
  --query <text>        Fuzzy search by name
  --tags <tag1,tag2>    Filter by tags (comma-separated)
  --match-all-tags      Require ALL tags (default: ANY)
  --include-blocks      Include agent.blocks in response
  --limit <n>           Max results (default: 20)
`);
      process.exit(1);
    }
  })();
}
