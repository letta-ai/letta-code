import { parseArgs } from "node:util";
import { getClient } from "../../agent/client";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../../constants";

type SearchMode = "vector" | "fts" | "hybrid";

function printUsage(): void {
  console.log(
    `
Usage:
  letta messages search --query <text> [options]
  letta messages list [options]
  letta messages start-conversation --agent <id> --message "<text>"
  letta messages continue-conversation --conversation-id <id> --message "<text>"

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

Conversation options:
  --agent <id>          Target agent ID (start-conversation)
  --message <text>      Message to send
  --conversation-id <id> Existing conversation ID (continue-conversation)
  --timeout <ms>        Max wait time (accepted for compatibility)

Notes:
  - Output is JSON only.
  - Uses CLI auth; override with LETTA_API_KEY/LETTA_BASE_URL if needed.
  - Sender agent ID is read from LETTA_AGENT_ID for conversation commands.
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

function getAgentId(agentFromArgs?: string, agentIdFromArgs?: string): string {
  return agentFromArgs || agentIdFromArgs || process.env.LETTA_AGENT_ID || "";
}

function buildSystemReminder(
  senderAgentName: string,
  senderAgentId: string,
): string {
  return `${SYSTEM_REMINDER_OPEN}
This message is from "${senderAgentName}" (agent ID: ${senderAgentId}), an agent currently running inside the Letta Code CLI (docs.letta.com/letta-code).
The sender will only see the final message you generate (not tool calls or reasoning).
If you need to share detailed information, include it in your response text.
${SYSTEM_REMINDER_CLOSE}

`;
}

async function extractAssistantResponse(
  stream: AsyncIterable<unknown>,
): Promise<string> {
  let finalResponse = "";
  for await (const chunk of stream) {
    if (process.env.DEBUG) {
      console.error("Chunk:", JSON.stringify(chunk, null, 2));
    }
    if (
      typeof chunk === "object" &&
      chunk !== null &&
      "message_type" in chunk &&
      (chunk as { message_type?: string }).message_type === "assistant_message"
    ) {
      const content = (chunk as { content?: unknown }).content;
      if (typeof content === "string") {
        finalResponse += content;
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            (part as { type?: string }).type === "text" &&
            "text" in part
          ) {
            finalResponse += (part as { text: string }).text;
          }
        }
      }
    }
  }
  return finalResponse;
}

export async function runMessagesSubcommand(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
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
        message: { type: "string" },
        "conversation-id": { type: "string" },
        timeout: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
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
        parsed.values.agent as string | undefined,
        parsed.values["agent-id"] as string | undefined,
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
        start_date: parsed.values["start-date"] as string | undefined,
        end_date: parsed.values["end-date"] as string | undefined,
        limit: parseLimit(parsed.values.limit, 10),
      });

      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    if (action === "list") {
      const agentId = getAgentId(
        parsed.values.agent as string | undefined,
        parsed.values["agent-id"] as string | undefined,
      );
      if (!agentId) {
        console.error(
          "Missing agent id. Set LETTA_AGENT_ID or pass --agent/--agent-id.",
        );
        return 1;
      }

      const response = await client.agents.messages.list(agentId, {
        limit: parseLimit(parsed.values.limit, 20),
        after: parsed.values.after as string | undefined,
        before: parsed.values.before as string | undefined,
        order: parsed.values.order as "asc" | "desc" | undefined,
      });

      const messages = response.items ?? [];
      const startDate = parsed.values["start-date"];
      const endDate = parsed.values["end-date"];

      let filtered = messages;
      if (startDate || endDate) {
        const startTime = startDate
          ? new Date(startDate as string).getTime()
          : 0;
        const endTime = endDate
          ? new Date(endDate as string).getTime()
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

    if (action === "start-conversation") {
      const agentId = getAgentId(
        parsed.values.agent as string | undefined,
        parsed.values["agent-id"] as string | undefined,
      );
      if (!agentId) {
        console.error("Missing target agent id. Use --agent/--agent-id.");
        return 1;
      }
      const message = parsed.values.message;
      if (!message || typeof message !== "string") {
        console.error("Missing required --message <text>.");
        return 1;
      }

      const senderAgentId = process.env.LETTA_AGENT_ID;
      if (!senderAgentId) {
        console.error(
          "Missing LETTA_AGENT_ID for sender. Run inside a Letta Code session.",
        );
        return 1;
      }

      const targetAgent = await client.agents.retrieve(agentId);
      const senderAgent = await client.agents.retrieve(senderAgentId);
      const conversation = await client.conversations.create({
        agent_id: targetAgent.id,
      });

      const systemReminder = buildSystemReminder(
        senderAgent.name,
        senderAgentId,
      );
      const fullMessage = systemReminder + message;
      const stream = await client.conversations.messages.create(
        conversation.id,
        {
          input: fullMessage,
          streaming: true,
        },
      );

      const response = await extractAssistantResponse(stream);
      console.log(
        JSON.stringify(
          {
            conversation_id: conversation.id,
            response,
            agent_id: targetAgent.id,
            agent_name: targetAgent.name,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (action === "continue-conversation") {
      const conversationId = parsed.values["conversation-id"];
      if (!conversationId || typeof conversationId !== "string") {
        console.error("Missing required --conversation-id <conversation-id>.");
        return 1;
      }
      const message = parsed.values.message;
      if (!message || typeof message !== "string") {
        console.error("Missing required --message <text>.");
        return 1;
      }

      const senderAgentId = process.env.LETTA_AGENT_ID;
      if (!senderAgentId) {
        console.error(
          "Missing LETTA_AGENT_ID for sender. Run inside a Letta Code session.",
        );
        return 1;
      }

      const conversation = await client.conversations.retrieve(conversationId);
      const targetAgent = await client.agents.retrieve(conversation.agent_id);
      const senderAgent = await client.agents.retrieve(senderAgentId);

      const systemReminder = buildSystemReminder(
        senderAgent.name,
        senderAgentId,
      );
      const fullMessage = systemReminder + message;
      const stream = await client.conversations.messages.create(
        conversationId,
        {
          input: fullMessage,
          streaming: true,
        },
      );

      const response = await extractAssistantResponse(stream);
      console.log(
        JSON.stringify(
          {
            conversation_id: conversationId,
            response,
            agent_id: targetAgent.id,
            agent_name: targetAgent.name,
          },
          null,
          2,
        ),
      );
      return 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  console.error(`Unknown action: ${action}`);
  printUsage();
  return 1;
}
