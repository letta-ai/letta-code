import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { getClient } from "../../agent/client";

type SearchMode = "vector" | "fts" | "hybrid";
type ListOrder = "asc" | "desc";

type TranscriptMessage = {
  id?: string;
  date?: string;
  message_type?: string;
  content?: unknown;
  reasoning?: string;
  tool_calls?: Array<{
    tool_call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  tool_call?: {
    tool_call_id?: string;
    name?: string;
    arguments?: string;
  };
  tool_call_id?: string;
  status?: string;
  tool_return?: unknown;
  func_response?: unknown;
  tool_returns?: Array<{
    tool_call_id?: string;
    status?: string;
    tool_return?: unknown;
    func_response?: unknown;
  }>;
};

function printUsage(): void {
  console.log(
    `
Usage:
  letta messages search --query <text> [options]
  letta messages list [options]
  letta messages transcript --conversation <id> [options]

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

Transcript options:
  --conversation <id>    Conversation ID to export (required)
  --conversation-id <id> Alias for --conversation
  --agent <id>           Required when conversation is "default"
  --agent-id <id>        Alias for --agent
  --limit <n>            Page size while fetching (default: 100)
  --max-pages <n>        Max pagination pages to fetch (default: 200)
  --out <path>           Write transcript text to file
  --output <path>        Alias for --out

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
  if (typeof value === "string" && (value === "asc" || value === "desc")) {
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
  conversation: { type: "string" },
  "conversation-id": { type: "string" },
  "max-pages": { type: "string" },
  out: { type: "string" },
  output: { type: "string" },
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

    const renderText = (value: unknown): string => {
      if (typeof value === "string") return value;
      if (!Array.isArray(value)) return "";

      return value
        .map((part) => {
          if (
            part &&
            typeof part === "object" &&
            "type" in part &&
            part.type === "text" &&
            "text" in part
          ) {
            return typeof part.text === "string" ? part.text : "";
          }
          return "";
        })
        .filter((text) => text.length > 0)
        .join("\n");
    };

    const renderUnknown = (value: unknown): string => {
      if (typeof value === "string") return value;
      if (value === null || value === undefined) return "";
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    const safeTypeLabel = (msg: TranscriptMessage): string =>
      msg.message_type || "unknown_message";

    const formatEntry = (msg: TranscriptMessage): string[] => {
      const timestamp = msg.date || "unknown-time";
      const type = safeTypeLabel(msg);

      if (type === "user_message") {
        const text = renderText(msg.content);
        return [`[${timestamp}] user`, text || "(empty)"];
      }

      if (type === "assistant_message") {
        const text = renderText(msg.content);
        return [`[${timestamp}] assistant`, text || "(empty)"];
      }

      if (type === "reasoning_message") {
        return [
          `[${timestamp}] reasoning`,
          msg.reasoning && msg.reasoning.length > 0 ? msg.reasoning : "(empty)",
        ];
      }

      if (type === "tool_call_message" || type === "approval_request_message") {
        const calls = Array.isArray(msg.tool_calls)
          ? msg.tool_calls
          : msg.tool_call
            ? [msg.tool_call]
            : [];

        if (calls.length === 0) {
          return [`[${timestamp}] ${type}`, "(no tool call payload)"];
        }

        return calls.flatMap((call) => {
          const header = `[${timestamp}] tool_call ${call.name || "unknown"} (${call.tool_call_id || "no-id"})`;
          const args = call.arguments ? call.arguments : "{}";
          return [header, args];
        });
      }

      if (type === "tool_return_message") {
        const returns = Array.isArray(msg.tool_returns)
          ? msg.tool_returns
          : [
              {
                tool_call_id: msg.tool_call_id,
                status: msg.status,
                tool_return: msg.tool_return,
                func_response: msg.func_response,
              },
            ];

        return returns.flatMap((ret) => {
          const header = `[${timestamp}] tool_return (${ret.tool_call_id || "no-id"}) status=${ret.status || "unknown"}`;
          const body = renderUnknown(ret.tool_return ?? ret.func_response);
          return [header, body || "(empty)"];
        });
      }

      const fallbackText =
        renderText(msg.content) || renderUnknown(msg.content) || "(no content)";
      return [`[${timestamp}] ${type}`, fallbackText];
    };

    const sortChronological = (
      messages: TranscriptMessage[],
    ): TranscriptMessage[] => {
      return [...messages].sort((a, b) => {
        const ta = a.date ? new Date(a.date).getTime() : 0;
        const tb = b.date ? new Date(b.date).getTime() : 0;
        return ta - tb;
      });
    };

    const fetchConversationMessages = async (
      conversationId: string,
      agentIdForDefault: string | undefined,
      pageLimit: number,
      maxPages: number,
    ): Promise<TranscriptMessage[]> => {
      const collected: TranscriptMessage[] = [];
      const seenIds = new Set<string>();
      let cursorBefore: string | undefined;

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const page = await client.conversations.messages.list(conversationId, {
          limit: pageLimit,
          order: "desc",
          ...(conversationId === "default" && agentIdForDefault
            ? { agent_id: agentIdForDefault }
            : {}),
          ...(cursorBefore ? { before: cursorBefore } : {}),
        });

        const items = page.getPaginatedItems() as TranscriptMessage[];
        if (items.length === 0) {
          break;
        }

        let newItems = 0;
        for (const item of items) {
          const id = item.id;
          if (id && !seenIds.has(id)) {
            seenIds.add(id);
            collected.push(item);
            newItems += 1;
          }
        }

        cursorBefore = items[items.length - 1]?.id;

        // Stop if no new items (all duplicates) or partial page
        if (newItems === 0 || items.length < pageLimit) {
          break;
        }
      }

      return sortChronological(collected);
    };

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
        conversation_id: "default",
        limit: parseLimit(parsed.values.limit, 20),
        after: parsed.values.after,
        before: parsed.values.before,
        order,
      });

      const messages = response.getPaginatedItems() ?? [];
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

    if (action === "transcript") {
      const conversationId =
        parsed.values.conversation || parsed.values["conversation-id"];

      if (!conversationId || typeof conversationId !== "string") {
        console.error(
          "Missing conversation id. Pass --conversation <id> or --conversation-id <id>.",
        );
        return 1;
      }

      const agentId = getAgentId(
        parsed.values.agent,
        parsed.values["agent-id"],
      );

      if (conversationId === "default" && !agentId) {
        console.error(
          'Conversation "default" requires an agent id. Set LETTA_AGENT_ID or pass --agent/--agent-id.',
        );
        return 1;
      }

      const pageLimit = Math.max(1, parseLimit(parsed.values.limit, 100));
      const maxPages = Math.max(1, parseLimit(parsed.values["max-pages"], 200));
      const outputPathRaw = parsed.values.out || parsed.values.output;

      const messages = await fetchConversationMessages(
        conversationId,
        agentId || undefined,
        pageLimit,
        maxPages,
      );

      const transcript = messages
        .flatMap((msg) => formatEntry(msg))
        .join("\n\n")
        .trim();

      if (outputPathRaw && typeof outputPathRaw === "string") {
        const outputPath = resolve(process.cwd(), outputPathRaw);
        await writeFile(outputPath, `${transcript}\n`, "utf-8");
        console.log(
          JSON.stringify(
            {
              conversation_id: conversationId,
              agent_id: agentId || null,
              message_count: messages.length,
              output_path: outputPath,
            },
            null,
            2,
          ),
        );
        return 0;
      }

      console.log(
        JSON.stringify(
          {
            conversation_id: conversationId,
            agent_id: agentId || null,
            message_count: messages.length,
            transcript,
          },
          null,
          2,
        ),
      );
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
