#!/usr/bin/env npx tsx
/**
 * Continue Conversation - Send a follow-up message to an existing conversation
 *
 * This script is standalone and can be run outside the CLI process.
 * It reads auth from LETTA_API_KEY env var or ~/.letta/settings.json.
 * It reads sender agent ID from LETTA_AGENT_ID env var.
 *
 * Usage:
 *   npx tsx continue-conversation.ts --conversation-id <id> --message "<text>"
 *
 * Options:
 *   --conversation-id <id>   Existing conversation ID (required)
 *   --message <text>         Message to send (required)
 *   --timeout <ms>           Max wait time in ms (default: 120000)
 *
 * Output:
 *   JSON with conversation_id, response, agent_id, agent_name
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

interface ContinueConversationOptions {
  conversationId: string;
  message: string;
  timeout?: number;
}

interface ContinueConversationResult {
  conversation_id: string;
  response: string;
  agent_id: string;
  agent_name: string;
}

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
 * Get the sender agent ID from env var
 */
function getSenderAgentId(): string {
  if (process.env.LETTA_AGENT_ID) {
    return process.env.LETTA_AGENT_ID;
  }
  throw new Error(
    "No LETTA_AGENT_ID found. This script should be run from within a Letta Code session.",
  );
}

/**
 * Create a Letta client with auth from env/settings
 */
function createClient(): LettaClient {
  return new Letta({ apiKey: getApiKey() });
}

/**
 * Build the system reminder prefix for the message
 */
function buildSystemReminder(
  senderAgentName: string,
  senderAgentId: string,
): string {
  return `<system-reminder>
This message is from "${senderAgentName}" (agent ID: ${senderAgentId}), an agent currently running inside the Letta Code CLI (docs.letta.com/letta-code).
The sender will only see the final message you generate (not tool calls or reasoning).
If you need to share detailed information, include it in your response text.
</system-reminder>

`;
}

/**
 * Continue an existing conversation by sending a follow-up message
 * @param client - Letta client instance
 * @param options - Options including conversation ID and message
 * @returns Conversation result with response and metadata
 */
export async function continueConversation(
  client: LettaClient,
  options: ContinueConversationOptions,
): Promise<ContinueConversationResult> {
  const { conversationId, message } = options;

  // 1. Fetch conversation to get agent_id and validate it exists
  const conversation = await client.conversations.retrieve(conversationId);

  // 2. Fetch target agent to get name
  const targetAgent = await client.agents.retrieve(conversation.agent_id);

  // 3. Fetch sender agent to get name for system reminder
  const senderAgentId = getSenderAgentId();
  const senderAgent = await client.agents.retrieve(senderAgentId);

  // 4. Build message with system reminder prefix
  const systemReminder = buildSystemReminder(senderAgent.name, senderAgentId);
  const fullMessage = systemReminder + message;

  // 5. Send message and consume the stream
  // Note: conversations.messages.create always returns a Stream
  const stream = await client.conversations.messages.create(conversationId, {
    input: fullMessage,
  });

  // 6. Consume stream and extract final assistant message
  let finalResponse = "";
  for await (const chunk of stream) {
    if (chunk.message_type === "assistant_message") {
      // Content can be string or array of content parts
      const content = chunk.content;
      if (typeof content === "string") {
        finalResponse += content;
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            part.type === "text" &&
            "text" in part
          ) {
            finalResponse += (part as { text: string }).text;
          }
        }
      }
    }
  }

  return {
    conversation_id: conversationId,
    response: finalResponse,
    agent_id: targetAgent.id,
    agent_name: targetAgent.name,
  };
}

function parseArgs(args: string[]): ContinueConversationOptions {
  const conversationIdIndex = args.indexOf("--conversation-id");
  if (conversationIdIndex === -1 || conversationIdIndex + 1 >= args.length) {
    throw new Error(
      "Missing required argument: --conversation-id <conversation-id>",
    );
  }
  const conversationId = args[conversationIdIndex + 1] as string;

  const messageIndex = args.indexOf("--message");
  if (messageIndex === -1 || messageIndex + 1 >= args.length) {
    throw new Error("Missing required argument: --message <text>");
  }
  const message = args[messageIndex + 1] as string;

  const options: ContinueConversationOptions = { conversationId, message };

  const timeoutIndex = args.indexOf("--timeout");
  if (timeoutIndex !== -1 && timeoutIndex + 1 < args.length) {
    const timeout = Number.parseInt(args[timeoutIndex + 1] as string, 10);
    if (!Number.isNaN(timeout)) {
      options.timeout = timeout;
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
      const result = await continueConversation(client, options);
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      console.error(`
Usage: npx tsx continue-conversation.ts --conversation-id <id> --message "<text>"

Options:
  --conversation-id <id>   Existing conversation ID (required)
  --message <text>         Message to send (required)
  --timeout <ms>           Max wait time in ms (default: 120000)
`);
      process.exit(1);
    }
  })();
}
