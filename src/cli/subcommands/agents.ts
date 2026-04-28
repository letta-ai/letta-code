import { parseArgs } from "node:util";
import type { AgentListParams } from "@letta-ai/letta-client/resources/agents/agents";
import { getClient } from "../../agent/client";
import { type CreateAgentOptions, createAgent } from "../../agent/create";
import {
  buildCreateAgentOptionsForPersonality,
  createAgentForPersonality,
  enableMemfsForCreatedAgent,
  resolvePersonalityId,
} from "../../agent/personality";
import { settingsManager } from "../../settings-manager";

function printUsage(): void {
  console.log(
    `
Usage:
  letta agents list [options]
  letta agents create [options]

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
  --personality <name>  Personality preset: letta-code, linus, kawaii, claude, codex
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
      `Unknown personality: ${personalityInput}. Valid: letta-code, linus, kawaii, claude, codex`,
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
      settingsManager.pinGlobal(agentId);
    }

    // Re-fetch agent to get updated tags in output
    const client = await getClient();
    const updatedAgent = await client.agents.retrieve(agentId);

    console.log(JSON.stringify(updatedAgent, null, 2));
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
    const client = await getClient();
    const result = await client.agents.list(params);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
