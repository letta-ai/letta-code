#!/usr/bin/env npx ts-node
/**
 * Search Messages - Search past conversations with vector/FTS search
 *
 * Usage:
 *   npx ts-node search-messages.ts --query <text> [options]
 *
 * Options:
 *   --query <text>        Search query (required)
 *   --mode <mode>         Search mode: vector, fts, hybrid (default: hybrid)
 *   --start-date <date>   Filter messages after this date (ISO format)
 *   --end-date <date>     Filter messages before this date (ISO format)
 *   --limit <n>           Max results (default: 10)
 *   --all-agents          Search all agents, not just current agent
 *
 * Output:
 *   Raw API response with search results
 */

import type Letta from "@letta-ai/letta-client";
import { getClient } from "../../../../agent/client";
import { getCurrentAgentId } from "../../../../agent/context";
import { settingsManager } from "../../../../settings-manager";

interface SearchMessagesOptions {
  query: string;
  mode?: "vector" | "fts" | "hybrid";
  startDate?: string;
  endDate?: string;
  limit?: number;
  allAgents?: boolean;
  agentId?: string; // For testing - override agent ID
}

/**
 * Search messages in past conversations
 * @param client - Letta client instance
 * @param options - Search options
 * @returns Array of search results with scores
 */
export async function searchMessages(
  client: Letta,
  options: SearchMessagesOptions,
): Promise<Awaited<ReturnType<typeof client.messages.search>>> {
  // Default to current agent unless --all-agents is specified
  let agentId: string | undefined;
  if (!options.allAgents) {
    agentId = options.agentId ?? getCurrentAgentId();
  }

  return await client.messages.search({
    query: options.query,
    agent_id: agentId,
    search_mode: options.mode ?? "hybrid",
    start_date: options.startDate,
    end_date: options.endDate,
    limit: options.limit ?? 10,
  });
}

function parseArgs(args: string[]): SearchMessagesOptions {
  const queryIndex = args.indexOf("--query");
  if (queryIndex === -1 || queryIndex + 1 >= args.length) {
    throw new Error("Missing required argument: --query <text>");
  }

  const options: SearchMessagesOptions = {
    query: args[queryIndex + 1] as string,
  };

  const modeIndex = args.indexOf("--mode");
  if (modeIndex !== -1 && modeIndex + 1 < args.length) {
    const mode = args[modeIndex + 1] as string;
    if (mode === "vector" || mode === "fts" || mode === "hybrid") {
      options.mode = mode;
    }
  }

  const startDateIndex = args.indexOf("--start-date");
  if (startDateIndex !== -1 && startDateIndex + 1 < args.length) {
    options.startDate = args[startDateIndex + 1];
  }

  const endDateIndex = args.indexOf("--end-date");
  if (endDateIndex !== -1 && endDateIndex + 1 < args.length) {
    options.endDate = args[endDateIndex + 1];
  }

  const limitIndex = args.indexOf("--limit");
  if (limitIndex !== -1 && limitIndex + 1 < args.length) {
    const limit = Number.parseInt(args[limitIndex + 1] as string, 10);
    if (!Number.isNaN(limit)) {
      options.limit = limit;
    }
  }

  if (args.includes("--all-agents")) {
    options.allAgents = true;
  }

  const agentIdIndex = args.indexOf("--agent-id");
  if (agentIdIndex !== -1 && agentIdIndex + 1 < args.length) {
    options.agentId = args[agentIdIndex + 1];
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
      const result = await searchMessages(client, options);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      console.error(`
Usage: npx ts-node search-messages.ts --query <text> [options]

Options:
  --query <text>        Search query (required)
  --mode <mode>         Search mode: vector, fts, hybrid (default: hybrid)
  --start-date <date>   Filter messages after this date (ISO format)
  --end-date <date>     Filter messages before this date (ISO format)
  --limit <n>           Max results (default: 10)
  --all-agents          Search all agents, not just current agent
  --agent-id <id>       Explicit agent ID (for manual testing)
`);
      process.exit(1);
    }
  })();
}
