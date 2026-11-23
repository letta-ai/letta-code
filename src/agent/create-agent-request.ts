import type { CreateBlock } from "@letta-ai/letta-client/resources/blocks/blocks";
import { buildCreatedAgentTags } from "./agent-tags";
import { getDefaultMemoryBlocks } from "./memory";
import { getDefaultModel, resolveModel } from "./model-catalog";
import {
  buildPersonalityMemoryBlocks,
  getPersonalityCreationTags,
  getPersonalityDefaultMemoryFiles,
  getPersonalityOption,
  type PersonalityId,
} from "./personality-presets";
import { buildSystemPrompt, type MemoryPromptMode } from "./prompt-assets";

export const LETTA_CODE_AGENT_TYPE = "letta_v1_agent";

export const DEFAULT_CREATED_AGENT_BASE_TOOLS = ["web_search", "fetch_webpage"];

export type CreateAgentMemoryBlock = CreateBlock;

export const DEFAULT_ROOT_MEMORY_BLOCK: CreateAgentMemoryBlock = {
  label: "MEMORY",
  value: "# Memory\n",
  description: "Root memory index.",
};

export interface BuildCreateAgentRequestOptions {
  personalityId?: PersonalityId;
  name?: string;
  description?: string;
  model?: string;
  system?: string | null;
  isLettaCloud?: boolean;
  memoryPromptMode?: MemoryPromptMode;
  memoryBlocks?: CreateAgentMemoryBlock[];
  blockIds?: string[];
  extraTags?: string[];
  enableMemfs?: boolean;
  isSubagent?: boolean;
  baseTools?: string[];
  embedding?: string;
  hidden?: boolean;
  parallelToolCalls?: boolean;
  compactionModel?: string;
}

export interface CreateAgentRequest {
  agent_type: typeof LETTA_CODE_AGENT_TYPE;
  name?: string;
  description?: string;
  model: string;
  system: string | null;
  memory_blocks?: CreateAgentMemoryBlock[];
  block_ids?: string[];
  tags: string[];
  tools: string[];
  include_base_tools: false;
  include_base_tool_rules: false;
  initial_message_sequence: never[];
  parallel_tool_calls: boolean;
  compaction_settings: { model: string };
  embedding?: string;
  hidden?: boolean;
}

export type CreateAgentRequestForPersonality = CreateAgentRequest & {
  name: string;
  description: string;
  memory_blocks: CreateAgentMemoryBlock[];
  profile_picture?: {
    content: string;
  };
};

function mergeMemoryBlocks(
  base: CreateAgentMemoryBlock[],
  overrides: CreateAgentMemoryBlock[] | undefined,
): CreateAgentMemoryBlock[] {
  const blocks = base.map((block) => ({ ...block }));
  for (const override of overrides ?? []) {
    const index = blocks.findIndex((block) => block.label === override.label);
    if (index >= 0) {
      blocks[index] = { ...override };
    } else {
      blocks.push({ ...override });
    }
  }
  return blocks;
}

function ensureRootMemoryBlock(
  blocks: CreateAgentMemoryBlock[],
): CreateAgentMemoryBlock[] {
  return blocks.some((block) => block.label === DEFAULT_ROOT_MEMORY_BLOCK.label)
    ? blocks
    : [{ ...DEFAULT_ROOT_MEMORY_BLOCK }, ...blocks];
}

export async function buildCreateAgentRequest(
  options: BuildCreateAgentRequestOptions = {},
): Promise<CreateAgentRequest> {
  const personality = options.personalityId
    ? getPersonalityOption(options.personalityId)
    : undefined;
  const modelIdentifier = options.model ?? personality?.defaultModel;
  const modelHandle = modelIdentifier
    ? resolveModel(modelIdentifier)
    : getDefaultModel();
  if (!modelHandle) {
    throw new Error(`Unknown model: ${modelIdentifier}`);
  }

  if (
    !options.isSubagent &&
    options.enableMemfs !== undefined &&
    options.memoryPromptMode !== undefined &&
    options.enableMemfs !== (options.memoryPromptMode !== "standard")
  ) {
    throw new Error(
      "enableMemfs and memoryPromptMode must describe the same memory mode",
    );
  }
  const enableMemfs = options.isSubagent
    ? false
    : (options.enableMemfs ?? options.memoryPromptMode !== "standard");
  const memoryPromptMode = options.isSubagent
    ? "standard"
    : (options.memoryPromptMode ?? (enableMemfs ? "root-memfs" : "standard"));
  const personalityTags = options.personalityId
    ? getPersonalityCreationTags(options.personalityId)
    : [];
  const personalityBlocks = options.personalityId
    ? buildPersonalityMemoryBlocks(
        options.personalityId,
        await getDefaultMemoryBlocks(),
      )
    : [];
  const hasSuppliedMemoryBlocks =
    options.personalityId !== undefined || options.memoryBlocks !== undefined;
  const suppliedMemoryBlocks = hasSuppliedMemoryBlocks
    ? mergeMemoryBlocks(personalityBlocks, options.memoryBlocks)
    : [];
  const memoryBlocks = options.isSubagent
    ? undefined
    : memoryPromptMode === "root-memfs"
      ? ensureRootMemoryBlock(suppliedMemoryBlocks)
      : hasSuppliedMemoryBlocks
        ? suppliedMemoryBlocks
        : undefined;
  const blockIds = options.isSubagent ? undefined : options.blockIds;

  return {
    agent_type: LETTA_CODE_AGENT_TYPE,
    ...(options.name !== undefined || personality
      ? { name: options.name ?? personality?.label }
      : {}),
    ...(options.description !== undefined || personality
      ? { description: options.description ?? personality?.description }
      : {}),
    model: modelHandle,
    system:
      options.system !== undefined
        ? options.system
        : options.isLettaCloud
          ? null
          : buildSystemPrompt("default", memoryPromptMode),
    ...(memoryBlocks !== undefined ? { memory_blocks: memoryBlocks } : {}),
    ...(blockIds && blockIds.length > 0 ? { block_ids: blockIds } : {}),
    tags: buildCreatedAgentTags({
      enableMemfs,
      isSubagent: options.isSubagent,
      tags: [...personalityTags, ...(options.extraTags ?? [])],
    }),
    tools: [...(options.baseTools ?? DEFAULT_CREATED_AGENT_BASE_TOOLS)],
    include_base_tools: false,
    include_base_tool_rules: false,
    initial_message_sequence: [],
    parallel_tool_calls: options.parallelToolCalls ?? true,
    compaction_settings: {
      model: options.compactionModel ?? modelHandle,
    },
    ...(options.embedding !== undefined
      ? { embedding: options.embedding }
      : {}),
    ...(options.isSubagent
      ? { hidden: true }
      : options.hidden !== undefined
        ? { hidden: options.hidden }
        : {}),
  };
}

export async function buildCreateAgentRequestForPersonality(params: {
  personalityId: PersonalityId;
  name?: string;
  description?: string;
  model?: string;
  extraTags?: string[];
  isLettaCloud?: boolean;
}): Promise<CreateAgentRequestForPersonality> {
  const request = (await buildCreateAgentRequest({
    ...params,
    isLettaCloud: params.isLettaCloud ?? true,
  })) as CreateAgentRequestForPersonality;
  const profilePicture = getPersonalityDefaultMemoryFiles(
    params.personalityId,
  ).find((file) => file.path === "profile.png");
  if (!profilePicture) {
    return request;
  }
  const { getPersonalityAssetBase64 } = await import(
    "./personality-asset-content"
  );
  return {
    ...request,
    profile_picture: {
      content: await getPersonalityAssetBase64(profilePicture.assetId),
    },
  };
}
