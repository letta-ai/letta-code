/**
 * Utilities for creating an agent on the Letta API backend
 **/

import { join } from "node:path";
import type { AgentType } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  BlockResponse,
  CreateBlock,
} from "@letta-ai/letta-client/resources/blocks/blocks";
import { settingsManager } from "../settings-manager";
import { getToolNames } from "../tools/manager";
import { getClient } from "./client";
import { getDefaultMemoryBlocks } from "./memory";
import {
  formatAvailableModels,
  getModelUpdateArgs,
  resolveModel,
} from "./model";
import { updateAgentLLMConfig } from "./modify";
import { SYSTEM_PROMPT } from "./promptAssets";
import { SLEEPTIME_MEMORY_PERSONA } from "./prompts/sleeptime";
import { discoverSkills, formatSkillsForMemory, SKILLS_DIR } from "./skills";

export async function createAgent(
  name = "letta-cli-agent",
  model?: string,
  embeddingModel = "openai/text-embedding-3-small",
  updateArgs?: Record<string, unknown>,
  forceNewBlocks = false,
  skillsDirectory?: string,
  parallelToolCalls = true,
  enableSleeptime = false,
  systemPrompt?: string,
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
  const toolNames = [
    ...getToolNames(),
    "memory",
    "web_search",
    "conversation_search",
    "fetch_webpage",
  ];

  // Load memory blocks from .mdx files
  const defaultMemoryBlocks = await getDefaultMemoryBlocks();

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
    const skillsBlock = defaultMemoryBlocks.find((b) => b.label === "skills");
    if (skillsBlock) {
      skillsBlock.value = formatSkillsForMemory(
        skills,
        resolvedSkillsDirectory,
      );
    }
  } catch (error) {
    console.warn(
      `Failed to discover skills: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Load global shared memory blocks from user settings
  const settings = settingsManager.getSettings();
  const globalSharedBlockIds = settings.globalSharedBlockIds;

  // Load project-local shared blocks from project settings
  await settingsManager.loadProjectSettings();
  const projectSettings = settingsManager.getProjectSettings();
  const localSharedBlockIds = projectSettings.localSharedBlockIds;

  // Retrieve existing blocks (both global and local) and match them with defaults
  const existingBlocks = new Map<string, BlockResponse>();

  // Only load existing blocks if we're not forcing new blocks
  if (!forceNewBlocks) {
    // Load global blocks (persona, human)
    for (const [label, blockId] of Object.entries(globalSharedBlockIds)) {
      try {
        const block = await client.blocks.retrieve(blockId);
        existingBlocks.set(label, block);
      } catch {
        // Block no longer exists, will create new one
        console.warn(
          `Global block ${label} (${blockId}) not found, will create new one`,
        );
      }
    }

    // Load local blocks (style)
    for (const [label, blockId] of Object.entries(localSharedBlockIds)) {
      try {
        const block = await client.blocks.retrieve(blockId);
        existingBlocks.set(label, block);
      } catch {
        // Block no longer exists, will create new one
        console.warn(
          `Local block ${label} (${blockId}) not found, will create new one`,
        );
      }
    }
  }

  // Separate blocks into existing (reuse) and new (create)
  const blockIds: string[] = [];
  const blocksToCreate: Array<{ block: CreateBlock; label: string }> = [];

  for (const defaultBlock of defaultMemoryBlocks) {
    const existingBlock = existingBlocks.get(defaultBlock.label);
    if (existingBlock?.id) {
      // Reuse existing global shared block
      blockIds.push(existingBlock.id);
    } else {
      // Need to create this block
      blocksToCreate.push({
        block: defaultBlock,
        label: defaultBlock.label,
      });
    }
  }

  // Create new blocks and collect their IDs
  const newGlobalBlockIds: Record<string, string> = {};
  const newLocalBlockIds: Record<string, string> = {};

  for (const { block, label } of blocksToCreate) {
    try {
      const createdBlock = await client.blocks.create(block);
      if (!createdBlock.id) {
        throw new Error(`Created block ${label} has no ID`);
      }
      blockIds.push(createdBlock.id);

      // Categorize: project/skills are local, persona/human are global
      if (label === "project" || label === "skills") {
        newLocalBlockIds[label] = createdBlock.id;
      } else {
        newGlobalBlockIds[label] = createdBlock.id;
      }
    } catch (error) {
      console.error(`Failed to create block ${label}:`, error);
      throw error;
    }
  }

  // Save newly created global block IDs to user settings
  if (Object.keys(newGlobalBlockIds).length > 0) {
    settingsManager.updateSettings({
      globalSharedBlockIds: {
        ...globalSharedBlockIds,
        ...newGlobalBlockIds,
      },
    });
  }

  // Save newly created local block IDs to project settings
  if (Object.keys(newLocalBlockIds).length > 0) {
    settingsManager.updateProjectSettings(
      {
        localSharedBlockIds: {
          ...localSharedBlockIds,
          ...newLocalBlockIds,
        },
      },
      process.cwd(),
    );
  }

  // Get the model's context window from its configuration
  const modelUpdateArgs = getModelUpdateArgs(modelHandle);
  const contextWindow = (modelUpdateArgs?.context_window as number) || 200_000;

  // Create agent with all block IDs (existing + newly created)
  const agent = await client.agents.create({
    agent_type: "letta_v1_agent" as AgentType,
    system: systemPrompt || SYSTEM_PROMPT,
    name,
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

  // Apply updateArgs if provided (e.g., reasoningEffort, verbosity, etc.)
  // Skip if updateArgs only contains context_window (already set in create)
  if (updateArgs && Object.keys(updateArgs).length > 0) {
    // Remove context_window if present; already set during create
    const otherArgs = { ...updateArgs } as Record<string, unknown>;
    delete (otherArgs as Record<string, unknown>).context_window;
    if (Object.keys(otherArgs).length > 0) {
      await updateAgentLLMConfig(
        agent.id,
        modelHandle,
        otherArgs,
        true, // preserve parallel_tool_calls
      );
    }
  }

  // Always retrieve the agent to ensure we get the full state with populated memory blocks
  const fullAgent = await client.agents.retrieve(agent.id, {
    include: ["agent.managed_group"],
  });

  // Update persona block for sleeptime agent (only if persona was newly created, not shared)
  if (enableSleeptime && newGlobalBlockIds.persona && fullAgent.managed_group) {
    // Find the sleeptime agent in the managed group by checking agent_type
    for (const groupAgentId of fullAgent.managed_group.agent_ids) {
      try {
        const groupAgent = await client.agents.retrieve(groupAgentId);
        if (groupAgent.agent_type === "sleeptime_agent") {
          // Update the persona block on the SLEEPTIME agent, not the primary agent
          await client.agents.blocks.modify("memory_persona", {
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

  return fullAgent;
}
