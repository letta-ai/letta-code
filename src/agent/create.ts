/**
 * Utilities for creating an agent on the Letta API backend
 **/

import { join } from "node:path";
import type {
  AgentState,
  AgentType,
} from "@letta-ai/letta-client/resources/agents/agents";
import { DEFAULT_AGENT_NAME } from "../constants";
import { getClient } from "./client";
import { getDefaultMemoryBlocks } from "./memory";
import {
  formatAvailableModels,
  getModelUpdateArgs,
  resolveModel,
} from "./model";
import { updateAgentLLMConfig } from "./modify";
import { resolveSystemPrompt } from "./promptAssets";
import { SLEEPTIME_MEMORY_PERSONA } from "./prompts/sleeptime";
import { discoverSkills, formatSkillsForMemory, SKILLS_DIR } from "./skills";

/**
 * Describes where a memory block came from
 */
export interface BlockProvenance {
  label: string;
  source: "global" | "project" | "new" | "shared";
}

/**
 * Provenance info for an agent creation
 */
export interface AgentProvenance {
  isNew: true;
  blocks: BlockProvenance[];
}

/**
 * Result from createAgent including provenance info
 */
export interface CreateAgentResult {
  agent: AgentState;
  provenance: AgentProvenance;
}

export interface CreateAgentOptions {
  name?: string;
  /** Agent description shown in /agents selector */
  description?: string;
  model?: string;
  embeddingModel?: string;
  updateArgs?: Record<string, unknown>;
  skillsDirectory?: string;
  parallelToolCalls?: boolean;
  enableSleeptime?: boolean;
  /** System prompt preset (e.g., 'default', 'letta-claude', 'letta-codex') */
  systemPromptPreset?: string;
  /** Raw system prompt string (mutually exclusive with systemPromptPreset) */
  systemPromptCustom?: string;
  /** Additional text to append to the resolved system prompt */
  systemPromptAppend?: string;
  /** Block labels to initialize (from default blocks) */
  initBlocks?: string[];
  /** Base tools to include */
  baseTools?: string[];
  /** Custom memory blocks (overrides default blocks) */
  memoryBlocks?: Array<
    { label: string; value: string; description?: string } | { blockId: string }
  >;
  /** Override values for preset blocks (label → value) */
  blockValues?: Record<string, string>;
}

export async function createAgent(
  nameOrOptions: string | CreateAgentOptions = DEFAULT_AGENT_NAME,
  model?: string,
  embeddingModel?: string,
  updateArgs?: Record<string, unknown>,
  skillsDirectory?: string,
  parallelToolCalls = true,
  enableSleeptime = false,
  systemPromptPreset?: string,
  initBlocks?: string[],
  baseTools?: string[],
) {
  // Support both old positional args and new options object
  let options: CreateAgentOptions;
  if (typeof nameOrOptions === "object") {
    options = nameOrOptions;
  } else {
    options = {
      name: nameOrOptions,
      model,
      embeddingModel,
      updateArgs,
      skillsDirectory,
      parallelToolCalls,
      enableSleeptime,
      systemPromptPreset,
      initBlocks,
      baseTools,
    };
  }

  const name = options.name ?? DEFAULT_AGENT_NAME;
  const embeddingModelVal = options.embeddingModel;
  const parallelToolCallsVal = options.parallelToolCalls ?? true;
  const enableSleeptimeVal = options.enableSleeptime ?? false;

  // Resolve model identifier to handle
  let modelHandle: string;
  if (options.model) {
    const resolved = resolveModel(options.model);
    if (!resolved) {
      console.error(`Error: Unknown model "${options.model}"`);
      console.error("Available models:");
      console.error(formatAvailableModels());
      process.exit(1);
    }
    modelHandle = resolved;
  } else {
    // Use default model
    modelHandle = "anthropic/claude-sonnet-4-5-20250929";
  }

  const client = await getClient();

  // Only attach server-side tools to the agent.
  // Client-side tools (Read, Write, Bash, etc.) are passed via client_tools at runtime,
  // NOT attached to the agent. This is the new pattern - no more stub tool registration.
  const { isOpenAIModel } = await import("../tools/manager");
  const baseMemoryTool = isOpenAIModel(modelHandle)
    ? "memory_apply_patch"
    : "memory";
  const defaultBaseTools = options.baseTools ?? [
    baseMemoryTool,
    "web_search",
    "fetch_webpage",
  ];

  let toolNames = [...defaultBaseTools];

  // Fallback: if server doesn't have memory_apply_patch, use legacy memory tool
  if (toolNames.includes("memory_apply_patch")) {
    try {
      const resp = await client.tools.list({ name: "memory_apply_patch" });
      const hasMemoryApplyPatch =
        Array.isArray(resp.items) && resp.items.length > 0;
      if (!hasMemoryApplyPatch) {
        console.warn(
          "memory_apply_patch tool not found on server; falling back to 'memory' tool",
        );
        toolNames = toolNames.map((n) =>
          n === "memory_apply_patch" ? "memory" : n,
        );
      }
    } catch (err) {
      // If the capability check fails for any reason, conservatively fall back to 'memory'
      console.warn(
        `Unable to verify memory_apply_patch availability (falling back to 'memory'): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      toolNames = toolNames.map((n) =>
        n === "memory_apply_patch" ? "memory" : n,
      );
    }
  }

  // Determine which memory blocks to use:
  // 1. If options.memoryBlocks is provided, use those (custom blocks and/or block references)
  // 2. Otherwise, use default blocks filtered by options.initBlocks

  // Separate block references from blocks to create
  const referencedBlockIds: string[] = [];
  let filteredMemoryBlocks: Array<{
    label: string;
    value: string;
    description?: string | null;
    limit?: number;
  }>;

  if (options.memoryBlocks !== undefined) {
    // Separate blockId references from CreateBlock items
    const createBlocks: typeof filteredMemoryBlocks = [];
    for (const item of options.memoryBlocks) {
      if ("blockId" in item) {
        referencedBlockIds.push(item.blockId);
      } else {
        createBlocks.push(item as (typeof filteredMemoryBlocks)[0]);
      }
    }
    filteredMemoryBlocks = createBlocks;
  } else {
    // Load memory blocks from .mdx files
    const defaultMemoryBlocks =
      options.initBlocks && options.initBlocks.length === 0
        ? []
        : await getDefaultMemoryBlocks();

    // Optional filter: only initialize a subset of memory blocks on creation
    const allowedBlockLabels = options.initBlocks
      ? new Set(
          options.initBlocks.map((n) => n.trim()).filter((n) => n.length > 0),
        )
      : undefined;

    if (allowedBlockLabels && allowedBlockLabels.size > 0) {
      const knownLabels = new Set(defaultMemoryBlocks.map((b) => b.label));
      for (const label of Array.from(allowedBlockLabels)) {
        if (!knownLabels.has(label)) {
          console.warn(
            `Ignoring unknown init block "${label}". Valid blocks: ${Array.from(knownLabels).join(", ")}`,
          );
          allowedBlockLabels.delete(label);
        }
      }
    }

    filteredMemoryBlocks =
      allowedBlockLabels && allowedBlockLabels.size > 0
        ? defaultMemoryBlocks.filter((b) => allowedBlockLabels.has(b.label))
        : defaultMemoryBlocks;
  }

  // Apply blockValues overrides to preset blocks
  if (options.blockValues) {
    for (const [label, value] of Object.entries(options.blockValues)) {
      const block = filteredMemoryBlocks.find((b) => b.label === label);
      if (block) {
        block.value = value;
      } else {
        console.warn(
          `Ignoring --block-value for "${label}" - block not included in memory config`,
        );
      }
    }
  }

  // Resolve absolute path for skills directory
  const resolvedSkillsDirectory =
    options.skillsDirectory || join(process.cwd(), SKILLS_DIR);

  // Discover skills from .skills directory and populate skills memory block
  try {
    const { skills, errors } = await discoverSkills(resolvedSkillsDirectory);

    // Log any errors encountered during skill discovery
    if (errors.length > 0) {
      console.warn("Errors encountered during skill discovery:");
      for (const error of errors) {
        console.warn(`  ${error.path}: ${error.message}`);
      }
    }

    // Find and update the skills memory block with discovered skills
    const skillsBlock = filteredMemoryBlocks.find((b) => b.label === "skills");
    if (skillsBlock) {
      const formatted = formatSkillsForMemory(skills, resolvedSkillsDirectory);
      skillsBlock.value = formatted;
    }
  } catch (error) {
    console.warn(
      `Failed to discover skills: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Track provenance: which blocks were created
  // Note: We no longer reuse shared blocks - each agent gets fresh blocks
  const blockProvenance: BlockProvenance[] = [];

  // Mark new blocks for provenance tracking (actual creation happens in agents.create)
  for (const block of filteredMemoryBlocks) {
    blockProvenance.push({ label: block.label, source: "new" });
  }

  // Mark referenced blocks for provenance tracking
  for (const blockId of referencedBlockIds) {
    blockProvenance.push({ label: blockId, source: "shared" });
  }

  // Get the model's context window from its configuration (if known)
  // For unknown models (e.g., from self-hosted servers), don't set a context window
  // and let the server use its default
  const modelUpdateArgs = getModelUpdateArgs(modelHandle);
  const contextWindow = modelUpdateArgs?.context_window as number | undefined;

  // Resolve system prompt content:
  // 1. If systemPromptCustom is provided, use it as-is
  // 2. Otherwise, resolve systemPromptPreset to content
  // 3. If systemPromptAppend is provided, append it to the result
  let systemPromptContent: string;
  if (options.systemPromptCustom) {
    systemPromptContent = options.systemPromptCustom;
  } else {
    systemPromptContent = await resolveSystemPrompt(options.systemPromptPreset);
  }

  // Append additional instructions if provided
  if (options.systemPromptAppend) {
    systemPromptContent = `${systemPromptContent}\n\n${options.systemPromptAppend}`;
  }

  // Create agent with inline memory blocks (LET-7101: single API call instead of N+1)
  // - memory_blocks: new blocks to create inline
  // - block_ids: references to existing blocks (for shared memory)
  const isSubagent = process.env.LETTA_CODE_AGENT_ROLE === "subagent";
  const tags = ["origin:letta-code"];
  if (isSubagent) {
    tags.push("role:subagent");
  }

  const agentDescription =
    options.description ?? `Letta Code agent created in ${process.cwd()}`;

  const agent = await client.agents.create({
    agent_type: "letta_v1_agent" as AgentType,
    system: systemPromptContent,
    name,
    description: agentDescription,
    embedding: embeddingModelVal || undefined,
    model: modelHandle,
    ...(contextWindow && { context_window_limit: contextWindow }),
    tools: toolNames,
    // New blocks created inline with agent (saves ~2s of sequential API calls)
    memory_blocks:
      filteredMemoryBlocks.length > 0 ? filteredMemoryBlocks : undefined,
    // Referenced block IDs (existing blocks to attach)
    block_ids: referencedBlockIds.length > 0 ? referencedBlockIds : undefined,
    tags,
    ...(isSubagent && { hidden: true }),
    // should be default off, but just in case
    include_base_tools: false,
    include_base_tool_rules: false,
    initial_message_sequence: [],
    parallel_tool_calls: parallelToolCallsVal,
    enable_sleeptime: enableSleeptimeVal,
  });

  // Note: Preflight check above falls back to 'memory' when 'memory_apply_patch' is unavailable.

  // Apply updateArgs if provided (e.g., context_window, reasoning_effort, verbosity, etc.)
  // We intentionally pass context_window through so updateAgentLLMConfig can set
  // context_window_limit using the latest server API, avoiding any fallback.
  if (options.updateArgs && Object.keys(options.updateArgs).length > 0) {
    await updateAgentLLMConfig(agent.id, modelHandle, options.updateArgs);
  }

  // Always retrieve the agent to ensure we get the full state with populated memory blocks
  const fullAgent = await client.agents.retrieve(agent.id, {
    include: ["agent.managed_group"],
  });

  // Update persona block for sleeptime agent
  if (enableSleeptimeVal && fullAgent.managed_group) {
    // Find the sleeptime agent in the managed group by checking agent_type
    for (const groupAgentId of fullAgent.managed_group.agent_ids) {
      try {
        const groupAgent = await client.agents.retrieve(groupAgentId);
        if (groupAgent.agent_type === "sleeptime_agent") {
          // Update the persona block on the SLEEPTIME agent, not the primary agent
          await client.agents.blocks.update("memory_persona", {
            agent_id: groupAgentId,
            value: SLEEPTIME_MEMORY_PERSONA,
            description:
              "Instructions for the sleep-time memory management agent",
          });
          break; // Found and updated sleeptime agent
        }
      } catch (error) {
        console.warn(
          `Failed to check/update agent ${groupAgentId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  // Build provenance info
  const provenance: AgentProvenance = {
    isNew: true,
    blocks: blockProvenance,
  };

  return { agent: fullAgent, provenance };
}
