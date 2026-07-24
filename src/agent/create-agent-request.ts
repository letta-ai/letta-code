/**
 * Pure builder for the `POST /v1/agents` wire payload of a Letta Code
 * personality agent.
 *
 * This is the shared source of truth between the CLI create path
 * (`createAgentForPersonality` → `createAgent`) and external surfaces that
 * create Letta Code agents directly through Core (e.g. the chat web app via
 * the `@letta-ai/letta-code/agent-presets` package export). It must stay free
 * of Node/backend imports so it can be bundled for the browser.
 *
 * Intentional differences from the CLI's `createAgent`:
 * - `context_window_limit` is omitted (the CLI resolves it via the models
 *   API at runtime); Core applies the default for the model handle.
 * - `embedding` is omitted (CLI only sets it when explicitly configured).
 */

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
import { buildSystemPrompt } from "./prompt-assets";

/** Agent type used for all Letta Code agents. */
export const LETTA_CODE_AGENT_TYPE = "letta_v1_agent";

/**
 * Server-side tools attached to created agents. Client-side tools (Read,
 * Write, Bash, etc.) are passed via client_tools at runtime instead.
 */
export const DEFAULT_CREATED_AGENT_BASE_TOOLS = ["web_search", "fetch_webpage"];

export interface CreateAgentRequestForPersonality {
  agent_type: string;
  name: string;
  description: string;
  model: string;
  system: string;
  memory_blocks: PersonalityMemoryBlock[];
  tags: string[];
  tools: string[];
  include_base_tools: boolean;
  include_base_tool_rules: boolean;
  initial_message_sequence: never[];
  parallel_tool_calls: boolean;
  compaction_settings: { model: string };
}

/**
 * Build the Core create-agent request body for a Letta Code personality
 * agent with git-backed (MemFS) memory — byte-identical content to what the
 * CLI sends when creating the same personality against the Letta API.
 */
export async function buildCreateAgentRequestForPersonality(params: {
  personalityId: PersonalityId;
  name?: string;
  description?: string;
  /** Model ID or handle; defaults to the personality's default model. */
  model?: string;
  /** Extra tags (e.g. a favorite tag) appended to the Letta Code tags. */
  extraTags?: string[];
}): Promise<CreateAgentRequestForPersonality> {
  const { personalityId, name, description, model, extraTags } = params;
  const personality = getPersonalityOption(personalityId);

  const modelIdentifier = model ?? personality.defaultModel;
  const modelHandle = modelIdentifier
    ? resolveModel(modelIdentifier)
    : getDefaultModel();
  if (!modelHandle) {
    throw new Error(`Unknown model: ${modelIdentifier}`);
  }

  const defaultMemoryBlocks = await getDefaultMemoryBlocks();

  return {
    agent_type: LETTA_CODE_AGENT_TYPE,
    name: name ?? personality.label,
    description: description ?? personality.description,
    model: modelHandle,
    system: buildSystemPrompt("default", "memfs"),
    memory_blocks: buildPersonalityMemoryBlocks(
      personalityId,
      defaultMemoryBlocks,
    ),
    tags: buildCreatedAgentTags({
      enableMemfs: true,
      tags: [
        ...getPersonalityCreationTags(personalityId),
        ...(extraTags ?? []),
      ],
    }),
    tools: [...DEFAULT_CREATED_AGENT_BASE_TOOLS],
    include_base_tools: false,
    include_base_tool_rules: false,
    initial_message_sequence: [],
    parallel_tool_calls: true,
    compaction_settings: { model: DEFAULT_SUMMARIZATION_MODEL },
  };
}
