import { parseArgs } from "node:util";
import type { AgentListParams } from "@letta-ai/letta-client/resources/agents/agents";
import { type CreateAgentOptions, createAgent } from "@/agent/create";
import {
  buildCreateAgentOptionsForPersonality,
  createAgentForPersonality,
  enableMemfsForCreatedAgent,
} from "@/agent/personality";
import { resolvePersonalityId } from "@/agent/personality-presets";
import { getBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";

function printUsage(): void {
  console.log(
    `
Usage:
  letta agents list [options]
  letta agents create [options]
  letta agents config [--agent <id> | --conversation <id>]

Config Options:
  --agent <id>          Show an agent's default model configuration
  --conversation <id>   Show a conversation override and its parent agent
  --conv <id>           Alias for --conversation

  With no options, uses AGENT_ID and CONVERSATION_ID from the current session.

List Options:
  --name <name>         Exact name match
  --query <text>        Fuzzy search by name
  --tags <tag1,tag2>    Filter by tags (comma-separated)
  --match-all-tags      Require ALL tags (default: ANY)
  --include-blocks      Include agent.blocks in response
  --limit <n>           Max results (default: 20)

Create Options:
  --name <name>         Agent name (default: "Letta Code")
  --model <model>       Model handle (e.g., anthropic/claude-sonnet-4-20250514)
  --personality <name>  Personality preset: letta-code, tutorial, blank, linus, kawaii, claude, codex
  --description <text>  Agent description
  --tags <tag1,tag2>    Tags (comma-separated)
  --pinned              Pin the created agent globally

  Creates a memfs-enabled agent with persona.md pre-populated.

Notes:
  - Output is JSON only.
  - Uses CLI auth; override with LETTA_API_KEY/LETTA_BASE_URL if needed.
`.trim(),
  );
}

function parseLimit(value: unknown, fallback: number): number {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseTags(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const tags = value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

const AGENTS_OPTIONS = {
  help: { type: "boolean", short: "h" },
  name: { type: "string" },
  query: { type: "string" },
  tags: { type: "string" },
  "match-all-tags": { type: "boolean" },
  "include-blocks": { type: "boolean" },
  limit: { type: "string" },
  // Config options
  agent: { type: "string" },
  conversation: { type: "string" },
  conv: { type: "string" },
  // Create options
  model: { type: "string" },
  personality: { type: "string" },
  description: { type: "string" },
  pinned: { type: "boolean" },
} as const;

function parseAgentsArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: AGENTS_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

export async function runAgentsSubcommand(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseAgentsArgs>;
  try {
    parsed = parseAgentsArgs(argv);
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

  if (action === "create") {
    return runCreateAction(parsed.values);
  }

  if (action === "list") {
    return runListAction(parsed.values);
  }

  if (action === "config") {
    return runConfigAction(parsed.values);
  }

  console.error(`Unknown action: ${action}`);
  printUsage();
  return 1;
}

async function runCreateAction(
  values: ReturnType<typeof parseAgentsArgs>["values"],
): Promise<number> {
  await settingsManager.initialize();

  const personalityInput = values.personality as string | undefined;
  const personality = personalityInput
    ? resolvePersonalityId(personalityInput)
    : undefined;

  if (personalityInput && !personality) {
    console.error(
      `Unknown personality: ${personalityInput}. Valid: letta-code, tutorial, blank, linus, kawaii, claude, codex`,
    );
    return 1;
  }

  const options: CreateAgentOptions = personality
    ? await buildCreateAgentOptionsForPersonality({
        personalityId: personality,
      })
    : {
        memoryPromptMode: "memfs",
      };

  if (typeof values.name === "string") {
    options.name = values.name;
  }

  if (typeof values.model === "string") {
    options.model = values.model;
  }

  if (typeof values.description === "string") {
    options.description = values.description;
  }

  const tags = parseTags(values.tags);
  if (tags) {
    options.tags = tags;
  }

  try {
    const result = personality
      ? await createAgentForPersonality({
          personalityId: personality,
          name: options.name,
          description: options.description,
          model: options.model,
          tags: options.tags,
        })
      : await createAgent(options);
    const agentId = result.agent.id;

    if (!personality) {
      await enableMemfsForCreatedAgent({
        agentId,
        agentTags: result.agent.tags,
      });
    }

    if (values.pinned) {
      settingsManager.pinAgent(agentId);
    }

    // Re-fetch agent through the active backend to get updated output.
    const updatedAgent = await getBackend().retrieveAgent(agentId);

    console.log(JSON.stringify(updatedAgent, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const SECRET_CONFIG_FIELD =
  /api[_-]?key|access[_-]?key|secret|credential|password|authorization|(^|[_-])(auth|refresh|access|bearer)?token($|[_-])/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactConfigSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfigSecrets);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SECRET_CONFIG_FIELD.test(key)
        ? "[redacted]"
        : redactConfigSecrets(nested),
    ]),
  );
}

function safeConfigEntity(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const output: Record<string, unknown> = {};
  for (const key of [
    "id",
    "agent_id",
    "name",
    "model",
    "context_window_limit",
  ]) {
    if (value[key] !== undefined) output[key] = value[key];
  }
  if (isRecord(value.model_settings)) {
    output.model_settings = redactConfigSecrets(value.model_settings);
  }
  if (
    isRecord(value.llm_config) &&
    value.llm_config.context_window !== undefined
  ) {
    output.llm_config = {
      context_window: value.llm_config.context_window,
    };
  }
  return output;
}

export function buildAgentConfigReport(
  agent: unknown,
  conversation: unknown,
): Record<string, unknown> {
  if (!isRecord(agent)) throw new Error("Agent configuration is unavailable");
  const conversationRecord = isRecord(conversation) ? conversation : null;
  const conversationSettings = conversationRecord?.model_settings;
  const hasConversationOverride = Boolean(
    (typeof conversationRecord?.model === "string" &&
      conversationRecord.model.length > 0) ||
      (isRecord(conversationSettings) &&
        Object.keys(conversationSettings).length > 0),
  );
  const effectiveSource = hasConversationOverride ? conversationRecord : agent;
  const effectiveSettings = isRecord(effectiveSource?.model_settings)
    ? effectiveSource.model_settings
    : isRecord(agent.model_settings)
      ? agent.model_settings
      : {};

  return {
    agent: safeConfigEntity(agent),
    conversation: safeConfigEntity(conversationRecord),
    effective: {
      scope: hasConversationOverride ? "conversation" : "agent",
      model:
        (typeof effectiveSource?.model === "string" && effectiveSource.model) ||
        agent.model ||
        null,
      model_settings: redactConfigSecrets(effectiveSettings),
    },
    note: "model is the configured handle; router handles do not identify the underlying model selected for one inference",
  };
}

async function runConfigAction(
  values: ReturnType<typeof parseAgentsArgs>["values"],
): Promise<number> {
  const explicitAgentId = values.agent as string | undefined;
  const conversationId = (values.conversation ?? values.conv) as
    | string
    | undefined;
  if (values.conversation && values.conv) {
    console.error("Use either --conversation or --conv, not both");
    return 1;
  }
  if (explicitAgentId && conversationId) {
    console.error("Use either --agent or --conversation, not both");
    return 1;
  }

  await settingsManager.initialize();
  const backend = getBackend();

  try {
    let agentId = explicitAgentId;
    let conversation: unknown = null;

    if (conversationId && conversationId !== "default") {
      conversation = await backend.retrieveConversation(conversationId);
      if (
        !isRecord(conversation) ||
        typeof conversation.agent_id !== "string"
      ) {
        throw new Error(
          `Conversation ${conversationId} did not identify its parent agent`,
        );
      }
      agentId = conversation.agent_id;
    } else if (!agentId) {
      const environmentAgentId = process.env.AGENT_ID;
      const currentConversationId =
        conversationId ?? process.env.CONVERSATION_ID;
      if (currentConversationId && currentConversationId !== "default") {
        conversation = await backend.retrieveConversation(
          currentConversationId,
        );
        if (
          !isRecord(conversation) ||
          typeof conversation.agent_id !== "string"
        ) {
          throw new Error(
            `Conversation ${currentConversationId} did not identify its parent agent`,
          );
        }
        if (
          environmentAgentId &&
          conversation.agent_id !== environmentAgentId
        ) {
          throw new Error(
            `Conversation ${currentConversationId} belongs to ${conversation.agent_id}, not current AGENT_ID ${environmentAgentId}`,
          );
        }
        agentId = conversation.agent_id;
      } else {
        agentId = environmentAgentId;
      }
    }

    if (!agentId) {
      throw new Error(
        "Set AGENT_ID or pass --agent/--conversation to inspect configuration",
      );
    }

    const agent = await backend.retrieveAgent(agentId);
    console.log(
      JSON.stringify(buildAgentConfigReport(agent, conversation), null, 2),
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runListAction(
  values: ReturnType<typeof parseAgentsArgs>["values"],
): Promise<number> {
  await settingsManager.initialize();

  const params: AgentListParams = {
    limit: parseLimit(values.limit, 20),
  };

  if (typeof values.name === "string") {
    params.name = values.name;
  }

  if (typeof values.query === "string") {
    params.query_text = values.query;
  }

  const tags = parseTags(values.tags);
  if (tags) {
    params.tags = tags;
    if (values["match-all-tags"]) {
      params.match_all_tags = true;
    }
  }

  if (values["include-blocks"]) {
    params.include = ["agent.blocks"];
  }

  try {
    const result = await getBackend().listAgents(params);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
