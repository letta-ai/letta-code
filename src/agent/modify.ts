// src/agent/modify.ts
// Utilities for modifying agent configuration

import type {
  AgentState,
  AnthropicModelSettings,
  GoogleAIModelSettings,
  OpenAIModelSettings,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import { ANTHROPIC_PROVIDER_NAME } from "../providers/anthropic-provider";
import { getAllLettaToolNames, getToolNames } from "../tools/manager";
import { getClient } from "./client";

type ModelSettings =
  | OpenAIModelSettings
  | AnthropicModelSettings
  | GoogleAIModelSettings
  | Record<string, unknown>;

/**
 * Builds model_settings from updateArgs based on provider type.
 * Always ensures parallel_tool_calls is enabled.
 */
function buildModelSettings(
  modelHandle: string,
  updateArgs?: Record<string, unknown>,
): ModelSettings {
  const isOpenAI = modelHandle.startsWith("openai/");
  // Include our custom Anthropic OAuth provider (claude-pro-max)
  const isAnthropic =
    modelHandle.startsWith("anthropic/") ||
    modelHandle.startsWith(`${ANTHROPIC_PROVIDER_NAME}/`);
  const isGoogleAI = modelHandle.startsWith("google_ai/");
  const isGoogleVertex = modelHandle.startsWith("google_vertex/");
  const isOpenRouter = modelHandle.startsWith("openrouter/");

  let settings: ModelSettings;

  if (isOpenAI || isOpenRouter) {
    const openaiSettings: OpenAIModelSettings = {
      provider_type: "openai",
      parallel_tool_calls: true,
    };
    if (updateArgs?.reasoning_effort) {
      openaiSettings.reasoning = {
        reasoning_effort: updateArgs.reasoning_effort as
          | "none"
          | "minimal"
          | "low"
          | "medium"
          | "high",
      };
    }
    settings = openaiSettings;
  } else if (isAnthropic) {
    const anthropicSettings: AnthropicModelSettings = {
      provider_type: "anthropic",
      parallel_tool_calls: true,
    };
    // Build thinking config if either enable_reasoner or max_reasoning_tokens is specified
    if (
      updateArgs?.enable_reasoner !== undefined ||
      typeof updateArgs?.max_reasoning_tokens === "number"
    ) {
      anthropicSettings.thinking = {
        type: updateArgs?.enable_reasoner === false ? "disabled" : "enabled",
        ...(typeof updateArgs?.max_reasoning_tokens === "number" && {
          budget_tokens: updateArgs.max_reasoning_tokens,
        }),
      };
    }
    settings = anthropicSettings;
  } else if (isGoogleAI) {
    const googleSettings: GoogleAIModelSettings & { temperature?: number } = {
      provider_type: "google_ai",
      parallel_tool_calls: true,
    };
    if (updateArgs?.thinking_budget !== undefined) {
      googleSettings.thinking_config = {
        thinking_budget: updateArgs.thinking_budget as number,
      };
    }
    if (typeof updateArgs?.temperature === "number") {
      googleSettings.temperature = updateArgs.temperature as number;
    }
    settings = googleSettings;
  } else if (isGoogleVertex) {
    // Vertex AI uses the same Google provider on the backend; only the handle differs.
    const googleVertexSettings: Record<string, unknown> = {
      provider_type: "google_vertex",
      parallel_tool_calls: true,
    };
    if (updateArgs?.thinking_budget !== undefined) {
      (googleVertexSettings as Record<string, unknown>).thinking_config = {
        thinking_budget: updateArgs.thinking_budget as number,
      };
    }
    if (typeof updateArgs?.temperature === "number") {
      (googleVertexSettings as Record<string, unknown>).temperature =
        updateArgs.temperature as number;
    }
    settings = googleVertexSettings;
  } else {
    // For BYOK/unknown providers, return generic settings with parallel_tool_calls
    settings = {};
  }

  // Apply max_output_tokens for all providers if specified
  if (typeof updateArgs?.max_output_tokens === "number") {
    (settings as Record<string, unknown>).max_output_tokens =
      updateArgs.max_output_tokens;
  }

  return settings;
}

/**
 * Updates an agent's model and model settings.
 *
 * Uses the new model_settings field instead of deprecated llm_config.
 *
 * @param agentId - The agent ID
 * @param modelHandle - The model handle (e.g., "anthropic/claude-sonnet-4-5-20250929")
 * @param updateArgs - Additional config args (context_window, reasoning_effort, enable_reasoner, etc.)
 * @param preserveParallelToolCalls - If true, preserves the parallel_tool_calls setting when updating the model
 * @returns The updated LLM configuration from the server
 */
export async function updateAgentLLMConfig(
  agentId: string,
  modelHandle: string,
  updateArgs?: Record<string, unknown>,
): Promise<LlmConfig> {
  const client = await getClient();

  const modelSettings = buildModelSettings(modelHandle, updateArgs);
  const contextWindow = updateArgs?.context_window as number | undefined;
  const hasModelSettings = Object.keys(modelSettings).length > 0;

  await client.agents.update(agentId, {
    model: modelHandle,
    ...(hasModelSettings && { model_settings: modelSettings }),
    ...(contextWindow && { context_window_limit: contextWindow }),
  });

  const finalAgent = await client.agents.retrieve(agentId);
  return finalAgent.llm_config;
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
    const agent = await client.agents.retrieve(agentId, {
      include: ["agent.tools"],
    });
    const currentTools = agent.tools || [];
    const currentToolIds = currentTools
      .map((t) => t.id)
      .filter((id): id is string => typeof id === "string");
    const currentToolNames = new Set(
      currentTools
        .map((t) => t.name)
        .filter((name): name is string => typeof name === "string"),
    );

    // Get Letta Code tool names (internal names from registry)
    const { getServerToolName } = await import("../tools/manager");
    const lettaCodeToolNames = getToolNames();

    // Find tools to add (tools that aren't already attached)
    // Compare using server names since that's what the agent has
    const toolsToAdd = lettaCodeToolNames.filter((internalName) => {
      const serverName = getServerToolName(internalName);
      return !currentToolNames.has(serverName);
    });

    if (toolsToAdd.length === 0) {
      return {
        success: true,
        message: "All Letta Code tools already attached",
        addedCount: 0,
      };
    }

    // Look up tool IDs in parallel (instead of sequential calls)
    const toolsToAddIds = (
      await Promise.all(
        toolsToAdd.map(async (toolName) => {
          const serverName = getServerToolName(toolName);
          const toolsResponse = await client.tools.list({ name: serverName });
          return toolsResponse.items[0]?.id;
        }),
      )
    ).filter((id): id is string => !!id);

    // Combine current tools with new tools
    const newToolIds = [...currentToolIds, ...toolsToAddIds];

    // Get current tool_rules and add requires_approval rules for new tools
    // ALL Letta Code tools need requires_approval to be routed to the client
    const currentToolRules = agent.tool_rules || [];
    const newToolRules = [
      ...currentToolRules,
      ...toolsToAdd.map((toolName) => ({
        tool_name: getServerToolName(toolName),
        type: "requires_approval" as const,
        prompt_template: null,
      })),
    ];

    await client.agents.update(agentId, {
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
    const agent = await client.agents.retrieve(agentId, {
      include: ["agent.tools"],
    });
    const allTools = agent.tools || [];

    // Get all possible Letta Code tool names (both internal and server names)
    const { getServerToolName } = await import("../tools/manager");
    const lettaCodeToolNames = new Set(getAllLettaToolNames());
    const lettaCodeServerNames = new Set(
      Array.from(lettaCodeToolNames).map((name) => getServerToolName(name)),
    );

    // Filter out Letta Code tools, keep everything else
    // Check against server names since that's what the agent sees
    const remainingTools = allTools.filter(
      (t) => t.name && !lettaCodeServerNames.has(t.name),
    );
    const removedCount = allTools.length - remainingTools.length;

    // Extract IDs from remaining tools (filter out any undefined IDs)
    const remainingToolIds = remainingTools
      .map((t) => t.id)
      .filter((id): id is string => typeof id === "string");

    // Remove approval rules for Letta Code tools being unlinked
    // Check against server names since that's what appears in tool_rules
    const currentToolRules = agent.tool_rules || [];
    const remainingToolRules = currentToolRules.filter(
      (rule) =>
        rule.type !== "requires_approval" ||
        !lettaCodeServerNames.has(rule.tool_name),
    );

    await client.agents.update(agentId, {
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

export interface SystemPromptUpdateResult {
  success: boolean;
  message: string;
}

/**
 * Updates an agent's system prompt with raw content.
 *
 * @param agentId - The agent ID
 * @param systemPromptContent - The raw system prompt content to update
 * @returns Result with success status and message
 */
export async function updateAgentSystemPromptRaw(
  agentId: string,
  systemPromptContent: string,
): Promise<SystemPromptUpdateResult> {
  try {
    const client = await getClient();

    await client.agents.update(agentId, {
      system: systemPromptContent,
    });

    return {
      success: true,
      message: "System prompt updated successfully",
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to update system prompt: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Result from updating a system prompt on an agent
 */
export interface UpdateSystemPromptResult {
  success: boolean;
  message: string;
  agent: AgentState | null;
}

/**
 * Updates an agent's system prompt by ID or subagent name.
 * Resolves the ID to content, updates the agent, and returns the refreshed agent state.
 *
 * @param agentId - The agent ID to update
 * @param systemPromptId - System prompt ID (e.g., "codex") or subagent name (e.g., "explore")
 * @returns Result with success status, message, and updated agent state
 */
export async function updateAgentSystemPrompt(
  agentId: string,
  systemPromptId: string,
): Promise<UpdateSystemPromptResult> {
  try {
    const { resolveSystemPrompt } = await import("./promptAssets");
    const systemPromptContent = await resolveSystemPrompt(systemPromptId);

    const updateResult = await updateAgentSystemPromptRaw(
      agentId,
      systemPromptContent,
    );
    if (!updateResult.success) {
      return {
        success: false,
        message: updateResult.message,
        agent: null,
      };
    }

    // Re-fetch agent to get updated state
    const client = await getClient();
    const agent = await client.agents.retrieve(agentId);

    return {
      success: true,
      message: "System prompt applied successfully",
      agent,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to apply system prompt: ${error instanceof Error ? error.message : String(error)}`,
      agent: null,
    };
  }
}
