/**
 * Pure builder for the `POST /v1/agents` wire payload of a Letta Code agent.
 *
 * This is the shared creation-policy choke point for the CLI and external
 * harness surfaces. It owns the defaults that must not drift between callers:
 * agent type, prompt mode, tags, server tools, initial messages, parallel tool
 * calls, and compaction. Callers may supply either a Letta Code personality or
 * their own identity blocks without rebuilding that policy.
 *
 * Everything reachable from this module must stay free of Node/backend imports
 * so it can be bundled in the browser-safe `agent-presets` package export.
 */

import type { CreateBlock } from "@letta-ai/letta-client/resources/blocks/blocks";
import { DEFAULT_SUMMARIZATION_MODEL } from "@/constants";
import { buildCreatedAgentTags } from "./agent-tags";
import { getDefaultMemoryBlocks } from "./memory";
import { getDefaultModel, resolveModel } from "./model-catalog";
import {
  buildPersonalityMemoryBlocks,
  getPersonalityCreationTags,
  getPersonalityOption,
  type PersonalityId,
  type PersonalityMemoryBlock,
} from "./personality-presets";
import { buildSystemPrompt, type MemoryPromptMode } from "./prompt-assets";

/** Agent type used for all Letta Code agents. */
export const LETTA_CODE_AGENT_TYPE = "letta_v1_agent";

/**
 * Server-side tools attached to created agents. Client-side tools (Read,
 * Write, Bash, etc.) are passed via client_tools at runtime instead.
 */
export const DEFAULT_CREATED_AGENT_BASE_TOOLS = ["web_search", "fetch_webpage"];

export type CreateAgentMemoryBlock = CreateBlock;

export interface BuildCreateAgentRequestOptions {
  personalityId?: PersonalityId;
  name?: string;
  description?: string;
  /** Model ID or handle. Personality default, then catalog default, applies. */
  model?: string;
  /** Complete prompt override. Otherwise the standard prompt for prompt mode. */
  system?: string;
  memoryPromptMode?: MemoryPromptMode;
  /**
   * Caller-defined identity. With a personality, matching labels replace its
   * blocks and new labels append after the personality blocks.
   */
  memoryBlocks?: CreateAgentMemoryBlock[];
  blockIds?: string[];
  /** Extra tags appended after canonical Letta Code and personality tags. */
  extraTags?: string[];
  enableMemfs?: boolean;
  isSubagent?: boolean;
  /** Exact server-side tools. Omission uses the Letta Code web-tool defaults. */
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
  system: string;
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
  memory_blocks: PersonalityMemoryBlock[];
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

/** Build the canonical Core create-agent request for a Letta Code agent. */
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
    : (options.memoryPromptMode ?? (enableMemfs ? "memfs" : "standard"));
  const personalityTags = options.personalityId
    ? getPersonalityCreationTags(options.personalityId)
    : [];
  const personalityBlocks = options.personalityId
    ? buildPersonalityMemoryBlocks(
        options.personalityId,
        await getDefaultMemoryBlocks(),
      )
    : [];
  const memoryBlocks = options.isSubagent
    ? undefined
    : options.personalityId || options.memoryBlocks !== undefined
      ? mergeMemoryBlocks(personalityBlocks, options.memoryBlocks)
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
    system: options.system ?? buildSystemPrompt("default", memoryPromptMode),
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
      model: options.compactionModel ?? DEFAULT_SUMMARIZATION_MODEL,
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

/** Compatibility wrapper for callers that create a personality agent. */
export async function buildCreateAgentRequestForPersonality(params: {
  personalityId: PersonalityId;
  name?: string;
  description?: string;
  model?: string;
  extraTags?: string[];
}): Promise<CreateAgentRequestForPersonality> {
  return (await buildCreateAgentRequest(
    params,
  )) as CreateAgentRequestForPersonality;
}
