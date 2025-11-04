// src/agent/modify.ts
// Utilities for modifying agent configuration

import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import { getToolNames } from "../tools/manager";
import { getClient } from "./client";

/**
 * Updates an agent's model and LLM configuration.
 *
 * Note: Currently requires two PATCH calls due to SDK limitation.
 * Once SDK is fixed to allow contextWindow on PATCH, simplify this code to a single call.
 *
 * @param agentId - The agent ID
 * @param modelHandle - The model handle (e.g., "anthropic/claude-sonnet-4-5-20250929")
 * @param updateArgs - Additional LLM config args (contextWindow, reasoningEffort, verbosity, etc.)
 * @returns The updated LLM configuration from the server
 */
export async function updateAgentLLMConfig(
  agentId: string,
  modelHandle: string,
  updateArgs?: Record<string, unknown>,
): Promise<LlmConfig> {
  const client = await getClient();

  // Step 1: Update model (top-level field)
  await client.agents.modify(agentId, { model: modelHandle });

  // Step 2: Get updated agent to retrieve current llm_config
  const agent = await client.agents.retrieve(agentId);
  let finalConfig = agent.llm_config;

  // Step 3: If we have updateArgs, merge them into llm_config and patch again
  if (updateArgs && Object.keys(updateArgs).length > 0) {
    const updatedLlmConfig = {
      ...finalConfig,
      ...updateArgs,
    } as LlmConfig;
    await client.agents.modify(agentId, { llm_config: updatedLlmConfig });

    // Retrieve final state
    const finalAgent = await client.agents.retrieve(agentId);
    finalConfig = finalAgent.llm_config;
  }

  return finalConfig;
}

export interface LinkResult {
  success: boolean;
  message: string;
  addedCount?: number;
}

export interface UnlinkResult {
  success: boolean;
  message: string;
  removedCount?: number;
}

/**
 * Attach all Letta Code tools to an agent.
 *
 * @param agentId - The agent ID
 * @returns Result with success status and message
 */
export async function linkToolsToAgent(agentId: string): Promise<LinkResult> {
  try {
    const client = await getClient();

    // Get ALL agent tools from agent state
    const agent = await client.agents.retrieve(agentId);
    const currentTools = agent.tools || [];
    const currentToolIds = currentTools.map((t) => t.id);
    const currentToolNames = new Set(currentTools.map((t) => t.name));

    // Get Letta Code tool names
    const lettaCodeToolNames = getToolNames();

    // Find tools to add (tools that aren't already attached)
    const toolsToAdd = lettaCodeToolNames.filter(
      (name) => !currentToolNames.has(name),
    );

    if (toolsToAdd.length === 0) {
      return {
        success: true,
        message: "All Letta Code tools already attached",
        addedCount: 0,
      };
    }

    // Look up tool IDs from global tool list
    const toolsToAddIds: string[] = [];
    for (const toolName of toolsToAdd) {
      const tools = await client.tools.list({ name: toolName });
      if (tools.length > 0) {
        toolsToAddIds.push(tools[0].id);
      }
    }

    // Combine current tools with new tools
    const newToolIds = [...currentToolIds, ...toolsToAddIds];

    // Get current tool_rules and add requires_approval rules for new tools
    const currentToolRules = agent.tool_rules || [];
    const newToolRules = [
      ...currentToolRules,
      ...toolsToAdd.map((toolName) => ({
        tool_name: toolName,
        type: "requires_approval" as const,
        prompt_template: null,
      })),
    ];

    await client.agents.modify(agentId, {
      tool_ids: newToolIds,
      tool_rules: newToolRules,
    });

    return {
      success: true,
      message: `Attached ${toolsToAddIds.length} Letta Code tool(s) to agent`,
      addedCount: toolsToAddIds.length,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Remove all Letta Code tools from an agent.
 *
 * @param agentId - The agent ID
 * @returns Result with success status and message
 */
export async function unlinkToolsFromAgent(
  agentId: string,
): Promise<UnlinkResult> {
  try {
    const client = await getClient();

    // Get ALL agent tools from agent state (not tools.list which may be incomplete)
    const agent = await client.agents.retrieve(agentId);
    const allTools = agent.tools || [];
    const lettaCodeToolNames = new Set(getToolNames());

    // Filter out Letta Code tools, keep everything else
    const remainingTools = allTools.filter(
      (t) => !lettaCodeToolNames.has(t.name),
    );
    const removedCount = allTools.length - remainingTools.length;

    // Extract IDs from remaining tools
    const remainingToolIds = remainingTools.map((t) => t.id);

    // Remove approval rules for Letta Code tools being unlinked
    const currentToolRules = agent.tool_rules || [];
    const remainingToolRules = currentToolRules.filter(
      (rule: any) =>
        rule.type !== "requires_approval" ||
        !lettaCodeToolNames.has(rule.tool_name),
    );

    await client.agents.modify(agentId, {
      tool_ids: remainingToolIds,
      tool_rules: remainingToolRules,
    });

    return {
      success: true,
      message: `Removed ${removedCount} Letta Code tool(s) from agent`,
      removedCount,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
