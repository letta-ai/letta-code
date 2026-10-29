import { readFile } from "node:fs/promises";
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
import type { AgentCreateBody } from "@/backend/backend";
import { listSharedAgentsForCurrentUser } from "@/cli/helpers/shared-agent-listing";
import { getRuntimeActingUserId } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { readStdin } from "@/utils/stdin";

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
  --shared              List agents shared with the current user
  --limit <n>           Max results (default: 20)

Create Options:
  --name <name>         Agent name (default: "Letta Code")
  --model <model>       Model handle (e.g., anthropic/claude-sonnet-4-20250514)
  --personality <name>  Personality preset: letta-code, tutorial, blank, linus, kawaii, claude, codex
  --description <text>  Agent description
  --tags <tag1,tag2>    Tags (comma-separated)
  --pinned              Pin the created agent globally
  --body <path>         Create from a JSON agent create request instead of the
                        options above ("-" reads stdin)

  Creates a memfs-enabled agent with persona.md pre-populated. With --body, the
  request's system prompt, model settings, compaction settings, memory blocks,
  and tags are used as given.

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
  shared: { type: "boolean" },
  limit: { type: "string" },
  // Create options
  model: { type: "string" },
  personality: { type: "string" },
  description: { type: "string" },
  pinned: { type: "boolean" },
  body: { type: "string" },
} as const;

// Create options that --body replaces.
const BODY_EXCLUSIVE_OPTIONS = [
  "name",
  "model",
  "personality",
  "description",
  "tags",
] as const;

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

async function readCreateBody(source: string): Promise<AgentCreateBody> {
  const text =
    source === "-" ? await readStdin() : await readFile(source, "utf8");
  const body: unknown = JSON.parse(text);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("--body must contain a JSON object");
  }
  return body as AgentCreateBody;
}

async function createAgentFromBody(source: string): Promise<string> {
  const { prepareRawCreateAgentBodyForMemfs, enableMemfsIfCloud } =
    await import("@/agent/memory-filesystem");
  const body = await prepareRawCreateAgentBodyForMemfs(
    await readCreateBody(source),
  );
  const agent = await getBackend().createAgent(body);
  await enableMemfsIfCloud(agent.id, { agentTags: agent.tags });
  return agent.id;
}

async function printCreatedAgent(
  agentId: string,
  pinned: boolean,
): Promise<number> {
  if (pinned) {
    settingsManager.pinAgent(agentId);
  }

  // Re-fetch agent through the active backend to get updated output.
  const updatedAgent = await getBackend().retrieveAgent(agentId);

  console.log(JSON.stringify(updatedAgent, null, 2));
  return 0;
}

async function runCreateAction(
  values: ReturnType<typeof parseAgentsArgs>["values"],
): Promise<number> {
  await settingsManager.initialize();

  if (typeof values.body === "string") {
    const conflicting = BODY_EXCLUSIVE_OPTIONS.filter(
      (option) => values[option] !== undefined,
    );
    if (conflicting.length > 0) {
      console.error(
        `--body cannot be combined with ${conflicting.map((option) => `--${option}`).join(", ")}`,
      );
      return 1;
    }
    try {
      return await printCreatedAgent(
        await createAgentFromBody(values.body),
        Boolean(values.pinned),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

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

    return await printCreatedAgent(agentId, Boolean(values.pinned));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runListAction(
  values: ReturnType<typeof parseAgentsArgs>["values"],
): Promise<number> {
  await settingsManager.initialize();

  if (values.shared) {
    if (values.name || values.tags || values["match-all-tags"]) {
      console.error(
        "--shared supports --query and --limit; name and tag filters are not supported",
      );
      return 1;
    }
    if (values["include-blocks"]) {
      console.error("--include-blocks is not supported with --shared");
      return 1;
    }

    try {
      const result = await listSharedAgentsForCurrentUser(
        {
          limit: parseLimit(values.limit, 20),
          order: "desc",
          orderBy: "last_run_completion",
          queryText:
            typeof values.query === "string" ? values.query : undefined,
        },
        getRuntimeActingUserId(),
      );
      console.log(JSON.stringify(result, null, 2));
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

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
