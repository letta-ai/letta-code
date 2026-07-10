/**
 * Default agent (Letta Code) creation and management.
 *
 * Letta Code: Stateful agent with full memory - learns and grows with the user.
 */

import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Backend } from "@/backend";
import { getServerUrl } from "@/backend/api/client";
import { settingsManager } from "@/settings-manager";
import { type CreateAgentOptions, createAgent } from "./create";
import { parseMdxFrontmatter } from "./memory";
import { getDefaultModel, resolveModel } from "./model";
import { buildCreateAgentOptionsForPersonality } from "./personality";
import { MEMORY_PROMPTS } from "./prompt-assets";

// Tags used to identify default agents
export const MEMO_TAG = "default:memo";
export const TUTOR_TAG = "default:tutorial";

/**
 * Personalities the startup bootstrap can create. Kept deliberately simple:
 * a true fresh start (brand-new account, nothing to resume) gets the Tutor
 * onboarding agent, while an explicit `--new-agent` (and headless runs) get
 * the standard Letta Code (memo) agent.
 */
export type DefaultAgentPersonality = "memo" | "tutorial";

// Letta Code's default memory blocks - loaded from Memo-specific prompts.
const MEMO_PERSONA = parseMdxFrontmatter(
  MEMORY_PROMPTS["persona_memo.mdx"] ?? "",
).body;
const MEMO_HUMAN = parseMdxFrontmatter(
  MEMORY_PROMPTS["human_memo.mdx"] ?? "",
).body;

// Agent descriptions shown in /agents selector
const MEMO_DESCRIPTION = "The default Letta Code agent with persistent memory";

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
  backend: Backend,
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
      (await backend.listModels())
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
  backend: Backend,
  agentId: string,
  newTag: string,
): Promise<void> {
  try {
    const agent = await backend.retrieveAgent(agentId);
    const currentTags = agent.tags || [];
    if (!currentTags.includes(newTag)) {
      await backend.updateAgent(agentId, {
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
  backend: Backend,
  options?: {
    preferredModel?: string;
    /** Which personality the created agent gets. Defaults to memo (Letta Code). */
    personality?: DefaultAgentPersonality;
  },
): Promise<AgentState | null> {
  if (!settingsManager.shouldCreateDefaultAgents()) {
    return null;
  }

  const personality = options?.personality ?? "memo";

  try {
    // Pre-determine memfs mode so the agent is created with the correct prompt.
    const { isLettaCloud } = await import("@/agent/memory-filesystem");
    const willAutoEnableMemfs =
      backend.capabilities.remoteMemfs && (await isLettaCloud());
    const memoryPromptMode = backend.capabilities.localMemfs
      ? "local-memfs"
      : willAutoEnableMemfs
        ? "memfs"
        : undefined;

    const model = await resolveDefaultAgentModel(
      backend,
      options?.preferredModel,
    );

    const createOptions: CreateAgentOptions =
      personality === "tutorial"
        ? {
            ...(await buildCreateAgentOptionsForPersonality({
              personalityId: "tutorial",
              model,
            })),
            memoryPromptMode,
          }
        : {
            ...DEFAULT_AGENT_CONFIGS.memo,
            model,
            memoryPromptMode,
          };

    const { agent } = await createAgent(createOptions);
    await addTagToAgent(
      backend,
      agent.id,
      personality === "tutorial" ? TUTOR_TAG : MEMO_TAG,
    );
    settingsManager.pinAgent(agent.id);

    return agent;
  } catch (err) {
    // Re-throw so caller can handle/exit appropriately
    throw new Error(
      `Failed to create default agents: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
