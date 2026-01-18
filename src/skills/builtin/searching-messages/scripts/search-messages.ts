#!/usr/bin/env bun

/**
 * Search Messages - Search past conversations with vector/FTS search
 *
 * This script is standalone and can be run outside the CLI process.
 * It reads auth from LETTA_API_KEY env var or ~/.letta/settings.json.
 * It reads agent ID from LETTA_AGENT_ID env var or --agent-id arg.
 *
 * Usage:
 *   bun search-messages.ts --query <text> [options]
 *
 * Options:
 *   --query <text>        Search query (required)
 *   --mode <mode>         Search mode: vector, fts, hybrid (default: hybrid)
 *   --start-date <date>   Filter messages after this date (ISO format)
 *   --end-date <date>     Filter messages before this date (ISO format)
 *   --limit <n>           Max results (default: 10)
 *   --all-agents          Search all agents, not just current agent
 *   --agent-id <id>       Explicit agent ID (overrides LETTA_AGENT_ID env var)
 *
 * Output:
 *   Raw API response with search results
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

interface SearchMessagesOptions {
  query: string;
  mode?: "vector" | "fts" | "hybrid";
  startDate?: string;
  endDate?: string;
  limit?: number;
  allAgents?: boolean;
  agentId?: string;
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
 * Get agent ID from CLI arg, env var, or throw
 */
function getAgentId(cliArg?: string): string {
  // CLI arg takes precedence
  if (cliArg) return cliArg;

  // Then env var (set by CLI's getShellEnv)
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
 * Search messages in past conversations
 * @param client - Letta client instance
 * @param options - Search options
 * @returns Array of search results with scores
 */
export async function searchMessages(
  client: LettaClient,
  options: SearchMessagesOptions,
): Promise<Awaited<ReturnType<typeof client.messages.search>>> {
  // Default to current agent unless --all-agents is specified
  let agentId: string | undefined;
  if (!options.allAgents) {
    agentId = getAgentId(options.agentId);
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

// CLI entry point - check if this file is being run directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  (async () => {
    try {
      const options = parseArgs(process.argv.slice(2));
      const client = createClient();
      const result = await searchMessages(client, options);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      console.error(`
Usage: bun search-messages.ts --query <text> [options]

Options:
  --query <text>        Search query (required)
  --mode <mode>         Search mode: vector, fts, hybrid (default: hybrid)
  --start-date <date>   Filter messages after this date (ISO format)
  --end-date <date>     Filter messages before this date (ISO format)
  --limit <n>           Max results (default: 10)
  --all-agents          Search all agents, not just current agent
  --agent-id <id>       Explicit agent ID (overrides LETTA_AGENT_ID env var)
`);
      process.exit(1);
    }
  })();
}
