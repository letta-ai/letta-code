import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { ONBOARDING_ORIGIN_TAG } from "@/agent/agent-tags";
import type { Backend } from "@/backend";
import { getServerUrl } from "@/backend/api/server-url";
import { settingsManager } from "@/settings-manager";
import { type CreateAgentOptions, createAgent } from "./create";
import { parseMdxFrontmatter } from "./memory";
import { getDefaultModel, resolveModel } from "./model";
import { buildCreateAgentOptionsForPersonality } from "./personality";
import { MEMORY_PROMPTS } from "./prompt-assets";

export const MEMO_TAG = "default:memo";
export const TUTOR_TAG = "default:tutorial";

export type DefaultAgentPersonality = "memo" | "tutorial";

const MEMO_PERSONA = parseMdxFrontmatter(
  MEMORY_PROMPTS["persona_memo.mdx"] ?? "",
).body;
const MEMO_HUMAN = parseMdxFrontmatter(
  MEMORY_PROMPTS["human_memo.mdx"] ?? "",
).body;

const MEMO_DESCRIPTION = "The default Letta Code agent with persistent memory";

export const DEFAULT_AGENT_CONFIGS: Record<string, CreateAgentOptions> = {
  memo: {
    name: "Letta Code",
    description: MEMO_DESCRIPTION,
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

async function addTagToAgent(
  backend: Backend,
  agentId: string,
  newTag: string,
): Promise<void> {
  try {
    const agent = await backend.retrieveAgent(agentId, {
      include: ["agent.tags"],
    });
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

export async function ensureDefaultAgents(
  backend: Backend,
  options?: {
    preferredModel?: string;
    personality?: DefaultAgentPersonality;
  },
): Promise<AgentState | null> {
  if (!settingsManager.shouldCreateDefaultAgents()) {
    return null;
  }

  const personality = options?.personality ?? "memo";

  try {
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
              tags: [ONBOARDING_ORIGIN_TAG],
              environment: backend.capabilities.localMemfs ? "local" : "cloud",
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
    throw new Error(
      `Failed to create default agents: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
