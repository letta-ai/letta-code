#!/usr/bin/env npx ts-node
/**
 * Get Messages - Retrieve messages from an agent in chronological order
 *
 * Usage:
 *   npx ts-node get-messages.ts [options]
 *
 * Options:
 *   --start-date <date>   Filter messages after this date (ISO format)
 *   --end-date <date>     Filter messages before this date (ISO format)
 *   --limit <n>           Max results (default: 20)
 *   --agent-id <id>       Explicit agent ID (for manual testing)
 *   --after <message-id>  Cursor: get messages after this ID
 *   --before <message-id> Cursor: get messages before this ID
 *
 * Use this after search-messages.ts to expand around a found needle.
 *
 * Output:
 *   Messages in chronological order (filtered by date if specified)
 */

import type Letta from "@letta-ai/letta-client";
import { getClient } from "../../../../agent/client";
import { getCurrentAgentId } from "../../../../agent/context";
import { settingsManager } from "../../../../settings-manager";

interface GetMessagesOptions {
  startDate?: string;
  endDate?: string;
  limit?: number;
  agentId?: string;
  after?: string;
  before?: string;
  order?: "asc" | "desc";
}

/**
 * Get messages from an agent, optionally filtered by date range
 * @param client - Letta client instance
 * @param options - Options for filtering
 * @returns Array of messages in chronological order
 */
export async function getMessages(
  client: Letta,
  options: GetMessagesOptions = {},
): Promise<unknown[]> {
  const agentId = options.agentId ?? getCurrentAgentId();
  const limit = options.limit ?? 20;

  // Fetch messages from the agent
  const response = await client.agents.messages.list(agentId, {
    limit,
    after: options.after,
    before: options.before,
    order: options.order,
  });

  const messages = response.items ?? [];

  // Client-side date filtering if specified
  if (options.startDate || options.endDate) {
    const startTime = options.startDate
      ? new Date(options.startDate).getTime()
      : 0;
    const endTime = options.endDate
      ? new Date(options.endDate).getTime()
      : Number.POSITIVE_INFINITY;

    const filtered = messages.filter((msg) => {
      // Messages use 'date' field, not 'created_at'
      if (!("date" in msg) || !msg.date) return true;
      const msgTime = new Date(msg.date).getTime();
      return msgTime >= startTime && msgTime <= endTime;
    });

    // Sort chronologically (oldest first)
    return filtered.sort((a, b) => {
      const aDate = "date" in a && a.date ? new Date(a.date).getTime() : 0;
      const bDate = "date" in b && b.date ? new Date(b.date).getTime() : 0;
      return aDate - bDate;
    });
  }

  // Sort chronologically (oldest first)
  return [...messages].sort((a, b) => {
    const aDate = "date" in a && a.date ? new Date(a.date).getTime() : 0;
    const bDate = "date" in b && b.date ? new Date(b.date).getTime() : 0;
    return aDate - bDate;
  });
}

function parseArgs(args: string[]): GetMessagesOptions {
  const options: GetMessagesOptions = {};

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

  const agentIdIndex = args.indexOf("--agent-id");
  if (agentIdIndex !== -1 && agentIdIndex + 1 < args.length) {
    options.agentId = args[agentIdIndex + 1];
  }

  const afterIndex = args.indexOf("--after");
  if (afterIndex !== -1 && afterIndex + 1 < args.length) {
    options.after = args[afterIndex + 1];
  }

  const beforeIndex = args.indexOf("--before");
  if (beforeIndex !== -1 && beforeIndex + 1 < args.length) {
    options.before = args[beforeIndex + 1];
  }

  const orderIndex = args.indexOf("--order");
  if (orderIndex !== -1 && orderIndex + 1 < args.length) {
    const order = args[orderIndex + 1] as string;
    if (order === "asc" || order === "desc") {
      options.order = order;
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
      const result = await getMessages(client, options);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      console.error(`
Usage: npx ts-node get-messages.ts [options]

Options:
  --after <message-id>  Cursor: get messages after this ID
  --before <message-id> Cursor: get messages before this ID
  --order <asc|desc>    Sort order (default: desc = newest first)
  --limit <n>           Max results (default: 20)
  --agent-id <id>       Explicit agent ID (for manual testing)
  --start-date <date>   Client-side filter: after this date (ISO format)
  --end-date <date>     Client-side filter: before this date (ISO format)
`);
      process.exit(1);
    }
  })();
}
