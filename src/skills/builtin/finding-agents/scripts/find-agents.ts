#!/usr/bin/env npx ts-node
/**
 * Find Agents - Search for agents with various filters
 *
 * Usage:
 *   npx ts-node find-agents.ts [options]
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

import type Letta from "@letta-ai/letta-client";
import { getClient } from "../../../../agent/client";
import { settingsManager } from "../../../../settings-manager";

interface FindAgentsOptions {
  name?: string;
  query?: string;
  tags?: string[];
  matchAllTags?: boolean;
  includeBlocks?: boolean;
  limit?: number;
}

/**
 * Find agents matching the given criteria
 * @param client - Letta client instance
 * @param options - Search options
 * @returns Array of agent objects from the API
 */
export async function findAgents(
  client: Letta,
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

// CLI entry point
if (require.main === module) {
  (async () => {
    try {
      const options = parseArgs(process.argv.slice(2));
      await settingsManager.initialize();
      const client = await getClient();
      const result = await findAgents(client, options);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      console.error(`
Usage: npx ts-node find-agents.ts [options]

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
