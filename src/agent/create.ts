/**
 * Utilities for creating an agent on the Letta API backend
 **/

import { join } from "node:path";
import type {
  AgentState,
  AgentType,
} from "@letta-ai/letta-client/resources/agents/agents";
import { getToolNames } from "../tools/manager";
import { getClient } from "./client";
import { getDefaultMemoryBlocks } from "./memory";
import {
  formatAvailableModels,
  getModelUpdateArgs,
  resolveModel,
} from "./model";
import { updateAgentLLMConfig } from "./modify";
import { SYSTEM_PROMPT, SYSTEM_PROMPTS } from "./promptAssets";
import { SLEEPTIME_MEMORY_PERSONA } from "./prompts/sleeptime";
import { discoverSkills, formatSkillsForMemory, SKILLS_DIR } from "./skills";

/**
 * Describes where a memory block came from
 */
export interface BlockProvenance {
  label: string;
  source: "global" | "project" | "new";
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

export async function createAgent(
  name = "letta-code-agent",
  model?: string,
  embeddingModel = "openai/text-embedding-3-small",
  updateArgs?: Record<string, unknown>,
  skillsDirectory?: string,
  parallelToolCalls = true,
  enableSleeptime = false,
  systemPromptId?: string,
  initBlocks?: string[],
  baseTools?: string[],
) {
  // Resolve model identifier to handle
  let modelHandle: string;
  if (model) {
    const resolved = resolveModel(model);
    if (!resolved) {
      console.error(`Error: Unknown model "${model}"`);
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

  // Get loaded tool names (tools are already registered with Letta)
  // Map internal names to server names so the agent sees the correct tool names
  const { getServerToolName } = await import("../tools/manager");
  const internalToolNames = getToolNames();
  const serverToolNames = internalToolNames.map((name) =>
    getServerToolName(name),
  );

  const baseMemoryTool = modelHandle.startsWith("openai/gpt-5")
    ? "memory_apply_patch"
    : "memory";
  const defaultBaseTools = baseTools ?? [
    baseMemoryTool,
    "web_search",
    "conversation_search",
    "fetch_webpage",
  ];

  let toolNames = [...serverToolNames, ...defaultBaseTools];

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

  // Load memory blocks from .mdx files
  const defaultMemoryBlocks =
    initBlocks && initBlocks.length === 0 ? [] : await getDefaultMemoryBlocks();

  // Optional filter: only initialize a subset of memory blocks on creation
  const allowedBlockLabels = initBlocks
    ? new Set(
        initBlocks.map((name) => name.trim()).filter((name) => name.length > 0),
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

  const filteredMemoryBlocks =
    allowedBlockLabels && allowedBlockLabels.size > 0
      ? defaultMemoryBlocks.filter((b) => allowedBlockLabels.has(b.label))
      : defaultMemoryBlocks;

  // Resolve absolute path for skills directory
  const resolvedSkillsDirectory =
    skillsDirectory || join(process.cwd(), SKILLS_DIR);

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
  const blockIds: string[] = [];

  // Create all blocks fresh for the new agent
  for (const block of filteredMemoryBlocks) {
    try {
      const createdBlock = await client.blocks.create(block);
      if (!createdBlock.id) {
        throw new Error(`Created block ${block.label} has no ID`);
      }
      blockIds.push(createdBlock.id);
      blockProvenance.push({ label: block.label, source: "new" });
    } catch (error) {
      console.error(`Failed to create block ${block.label}:`, error);
      throw error;
    }
  }

  // Get the model's context window from its configuration
  const modelUpdateArgs = getModelUpdateArgs(modelHandle);
  const contextWindow = (modelUpdateArgs?.context_window as number) || 200_000;

  // Resolve system prompt (use specified ID or default)
  const systemPrompt = systemPromptId
    ? (SYSTEM_PROMPTS.find((p) => p.id === systemPromptId)?.content ??
      SYSTEM_PROMPT)
    : SYSTEM_PROMPT;

  // Create agent with all block IDs (existing + newly created)
  const agent = await client.agents.create({
    agent_type: "letta_v1_agent" as AgentType,
    system: systemPrompt,
    name,
    description: `Letta Code agent created in ${process.cwd()}`,
    embedding: embeddingModel,
    model: modelHandle,
    context_window_limit: contextWindow,
    tools: toolNames,
    block_ids: blockIds,
    tags: ["origin:letta-code"],
    // should be default off, but just in case
    include_base_tools: false,
    include_base_tool_rules: false,
    initial_message_sequence: [],
    parallel_tool_calls: parallelToolCalls,
    enable_sleeptime: enableSleeptime,
  });

  // Note: Preflight check above falls back to 'memory' when 'memory_apply_patch' is unavailable.

  // Apply updateArgs if provided (e.g., context_window, reasoning_effort, verbosity, etc.)
  // We intentionally pass context_window through so updateAgentLLMConfig can set
  // context_window_limit using the latest server API, avoiding any fallback.
  if (updateArgs && Object.keys(updateArgs).length > 0) {
    await updateAgentLLMConfig(agent.id, modelHandle, updateArgs);
  }

  // Always retrieve the agent to ensure we get the full state with populated memory blocks
  const fullAgent = await client.agents.retrieve(agent.id, {
    include: ["agent.managed_group"],
  });

  // Update persona block for sleeptime agent
  if (enableSleeptime && fullAgent.managed_group) {
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
