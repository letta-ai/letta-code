import { parseArgs } from "node:util";
import { getClient } from "../../agent/client";

type SearchMode = "vector" | "fts" | "hybrid";
type ListOrder = "asc" | "desc";

function printUsage(): void {
  console.log(
    `
Usage:
  letta messages search --query <text> [options]
  letta messages list [options]

Search options:
  --query <text>        Search query (required)
  --mode <mode>         Search mode: vector, fts, hybrid (default: hybrid)
  --start-date <date>   Filter messages after this date (ISO format)
  --end-date <date>     Filter messages before this date (ISO format)
  --limit <n>           Max results (default: 10)
  --all-agents          Search all agents, not just current agent
  --agent <id>          Explicit agent ID (overrides LETTA_AGENT_ID)
  --agent-id <id>       Alias for --agent

List options:
  --agent <id>          Agent ID (overrides LETTA_AGENT_ID)
  --agent-id <id>       Alias for --agent
  --after <message-id>  Cursor: get messages after this ID
  --before <message-id> Cursor: get messages before this ID
  --order <asc|desc>    Sort order (default: desc = newest first)
  --limit <n>           Max results (default: 20)
  --start-date <date>   Client-side filter: after this date (ISO format)
  --end-date <date>     Client-side filter: before this date (ISO format)

Notes:
  - Output is JSON only.
  - Uses CLI auth; override with LETTA_API_KEY/LETTA_BASE_URL if needed.
  - For agent-to-agent messaging, use: letta -p --from-agent <sender-id> --agent <target-id> "message"
`.trim(),
  );
}

function parseLimit(value: unknown, fallback: number): number {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseMode(value: unknown): SearchMode | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "vector" || value === "fts" || value === "hybrid") {
    return value;
  }
  return undefined;
}

function parseOrder(value: unknown): ListOrder | undefined {
  if (value === "asc" || value === "desc") {
    return value;
  }
  return undefined;
}

function getAgentId(agentFromArgs?: string, agentIdFromArgs?: string): string {
  return agentFromArgs || agentIdFromArgs || process.env.LETTA_AGENT_ID || "";
}

const MESSAGES_OPTIONS = {
  help: { type: "boolean", short: "h" },
  query: { type: "string" },
  mode: { type: "string" },
  "start-date": { type: "string" },
  "end-date": { type: "string" },
  limit: { type: "string" },
  "all-agents": { type: "boolean" },
  agent: { type: "string" },
  "agent-id": { type: "string" },
  after: { type: "string" },
  before: { type: "string" },
  order: { type: "string" },
} as const;

function parseMessagesArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: MESSAGES_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

export async function runMessagesSubcommand(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseMessagesArgs>;
  try {
    parsed = parseMessagesArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    printUsage();
    return 1;
  }

  const [action] = parsed.positionals;
  if (parsed.values.help || !action || action === "help") {
    printUsage();
    return 0;
  }

  try {
    const client = await getClient();

    if (action === "search") {
      const query = parsed.values.query;
      if (!query || typeof query !== "string") {
        console.error("Missing required --query <text>.");
        return 1;
      }

      const allAgents = parsed.values["all-agents"] ?? false;
      const agentId = getAgentId(
        parsed.values.agent,
        parsed.values["agent-id"],
      );
      if (!allAgents && !agentId) {
        console.error(
          "Missing agent id. Set LETTA_AGENT_ID or pass --agent/--agent-id.",
        );
        return 1;
      }

      const result = await client.messages.search({
        query,
        agent_id: allAgents ? undefined : agentId,
        search_mode: parseMode(parsed.values.mode) ?? "hybrid",
        start_date: parsed.values["start-date"],
        end_date: parsed.values["end-date"],
        limit: parseLimit(parsed.values.limit, 10),
      });

      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    if (action === "list") {
      const agentId = getAgentId(
        parsed.values.agent,
        parsed.values["agent-id"],
      );
      if (!agentId) {
        console.error(
          "Missing agent id. Set LETTA_AGENT_ID or pass --agent/--agent-id.",
        );
        return 1;
      }

      const orderRaw = parsed.values.order;
      const order = parseOrder(orderRaw);
      if (orderRaw !== undefined && !order) {
        console.error(`Invalid --order "${orderRaw}". Use "asc" or "desc".`);
        return 1;
      }

      const response = await client.agents.messages.list(agentId, {
        limit: parseLimit(parsed.values.limit, 20),
        after: parsed.values.after,
        before: parsed.values.before,
        order,
      });

      const messages = response.items ?? [];
      const startDate = parsed.values["start-date"];
      const endDate = parsed.values["end-date"];

      let filtered = messages;
      if (startDate || endDate) {
        const startTime = startDate ? new Date(startDate).getTime() : 0;
        const endTime = endDate
          ? new Date(endDate).getTime()
          : Number.POSITIVE_INFINITY;
        filtered = messages.filter((msg) => {
          if (!("date" in msg) || !msg.date) return true;
          const msgTime = new Date(msg.date).getTime();
          return msgTime >= startTime && msgTime <= endTime;
        });
      }

      const sorted = [...filtered].sort((a, b) => {
        const aDate = "date" in a && a.date ? new Date(a.date).getTime() : 0;
        const bDate = "date" in b && b.date ? new Date(b.date).getTime() : 0;
        return aDate - bDate;
      });

      console.log(JSON.stringify(sorted, null, 2));
      return 0;
    }

    // Agent-to-agent messaging uses `letta -p --from-agent <sender-id> ...`
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  console.error(`Unknown action: ${action}`);
  printUsage();
  return 1;
}
