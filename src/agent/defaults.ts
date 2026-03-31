/**
 * Default agents (Letta Code & Incognito) creation and management.
 *
 * Letta Code: Stateful agent with full memory - learns and grows with the user.
 * Incognito: Stateless agent - fresh experience without accumulated memory.
 */

import type { Letta } from "@letta-ai/letta-client";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { settingsManager } from "../settings-manager";
import { getServerUrl } from "./client";
import { type CreateAgentOptions, createAgent } from "./create";
import { parseMdxFrontmatter } from "./memory";
import { getDefaultModel, resolveModel } from "./model";
import { MEMORY_PROMPTS } from "./promptAssets";

// Tags used to identify default agents
export const MEMO_TAG = "default:memo";
export const INCOGNITO_TAG = "default:incognito";

// Letta Code's default memory blocks - loaded from Memo-specific prompts.
const MEMO_PERSONA = parseMdxFrontmatter(
  MEMORY_PROMPTS["persona_memo.mdx"] ?? "",
).body;
const MEMO_HUMAN = parseMdxFrontmatter(
  MEMORY_PROMPTS["human_memo.mdx"] ?? "",
).body;

// Agent descriptions shown in /agents selector
const MEMO_DESCRIPTION = "The default Letta Code agent with persistent memory";
const INCOGNITO_DESCRIPTION =
  "A stateless coding agent without memory (incognito mode)";

/**
 * Default agent configurations.
 */
export const DEFAULT_AGENT_CONFIGS: Record<string, CreateAgentOptions> = {
  memo: {
    name: "Letta Code",
    description: MEMO_DESCRIPTION,
    // Uses default memory blocks and tools (full stateful config)
    // Override global blocks with Memo-specific personality defaults
    blockValues: {
      persona: MEMO_PERSONA,
      human: MEMO_HUMAN,
    },
  },
  incognito: {
    name: "Incognito",
    description: INCOGNITO_DESCRIPTION,
    initBlocks: [], // No personal memory blocks
    baseTools: ["web_search", "fetch_webpage"], // No memory tool
  },
};

function isSelfHostedServer(): boolean {
  return !getServerUrl().includes("api.letta.com");
}

export function selectDefaultAgentModel(params: {
  preferredModel?: string;
  isSelfHosted: boolean;
  availableHandles?: Iterable<string>;
}): string | undefined {
  const { preferredModel, isSelfHosted, availableHandles } = params;
  const resolvedPreferred =
    typeof preferredModel === "string" && preferredModel.length > 0
      ? (resolveModel(preferredModel) ?? preferredModel)
      : undefined;

  if (!isSelfHosted) {
    return resolvedPreferred;
  }

  const handles = availableHandles ? new Set(availableHandles) : null;
  if (!handles) {
    return resolvedPreferred;
  }

  if (resolvedPreferred && handles.has(resolvedPreferred)) {
    return resolvedPreferred;
  }

  const firstNonAutoHandle = Array.from(handles).find(
    (handle) => handle !== "letta/auto" && handle !== "letta/auto-fast",
  );
  if (firstNonAutoHandle) {
    return firstNonAutoHandle;
  }

  const defaultHandle = getDefaultModel();
  if (handles.has(defaultHandle)) {
    return defaultHandle;
  }

  return Array.from(handles)[0];
}

async function resolveDefaultAgentModel(
  client: Letta,
  preferredModel?: string,
): Promise<string | undefined> {
  if (!isSelfHostedServer()) {
    return selectDefaultAgentModel({
      preferredModel,
      isSelfHosted: false,
    });
  }

  try {
    const availableHandles = new Set(
      (await client.models.list())
        .map((model) => model.handle)
        .filter((handle): handle is string => typeof handle === "string"),
    );

    return selectDefaultAgentModel({
      preferredModel,
      isSelfHosted: true,
      availableHandles,
    });
  } catch {
    return selectDefaultAgentModel({
      preferredModel,
      isSelfHosted: true,
    });
  }
}

/**
 * Add a tag to an existing agent.
 */
async function addTagToAgent(
  client: Letta,
  agentId: string,
  newTag: string,
): Promise<void> {
  try {
    const agent = await client.agents.retrieve(agentId);
    const currentTags = agent.tags || [];
    if (!currentTags.includes(newTag)) {
      await client.agents.update(agentId, {
        tags: [...currentTags, newTag],
      });
    }
  } catch (err) {
    console.warn(
      `Warning: Failed to add tag to agent: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Create a fresh default Letta Code agent and pin it globally.
 * Always creates a new agent — does NOT search by tag to avoid picking up
 * agents created by other users on shared Letta Cloud orgs.
 *
 * Respects `createDefaultAgents` setting (defaults to true).
 *
 * @returns The Letta Code agent (or null if creation disabled/failed).
 */
export async function ensureDefaultAgents(
  client: Letta,
  options?: {
    preferredModel?: string;
  },
): Promise<AgentState | null> {
  if (!settingsManager.shouldCreateDefaultAgents()) {
    return null;
  }

  try {
    // Pre-determine memfs mode so the agent is created with the correct prompt.
    const { isLettaCloud, enableMemfsIfCloud } = await import(
      "./memoryFilesystem"
    );
    const willAutoEnableMemfs = await isLettaCloud();

    const { agent } = await createAgent({
      ...DEFAULT_AGENT_CONFIGS.memo,
      model: await resolveDefaultAgentModel(client, options?.preferredModel),
      memoryPromptMode: willAutoEnableMemfs ? "memfs" : undefined,
    });
    await addTagToAgent(client, agent.id, MEMO_TAG);
    settingsManager.pinGlobal(agent.id);

    // Enable memfs on Letta Cloud (tags, repo clone, tool detach).
    await enableMemfsIfCloud(agent.id);

    return agent;
  } catch (err) {
    // Re-throw so caller can handle/exit appropriately
    throw new Error(
      `Failed to create default agents: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
