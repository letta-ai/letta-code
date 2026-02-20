// src/agent/modify.ts
// Utilities for modifying agent configuration

import type {
  AgentState,
  AnthropicModelSettings,
  GoogleAIModelSettings,
  OpenAIModelSettings,
} from "@letta-ai/letta-client/resources/agents/agents";
import { OPENAI_CODEX_PROVIDER_NAME } from "../providers/openai-codex-provider";
import { getClient } from "./client";

type ModelSettings =
  | OpenAIModelSettings
  | AnthropicModelSettings
  | GoogleAIModelSettings
  | Record<string, unknown>;

function hasUpdateArg(
  updateArgs: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return !!updateArgs && Object.hasOwn(updateArgs, key);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Builds model_settings from updateArgs based on provider type.
 *
 * Selective behavior: only keys explicitly present in updateArgs are applied.
 * Unrelated keys from existing model_settings are preserved.
 */
function buildModelSettings(
  modelHandle: string,
  existingModelSettings: Record<string, unknown>,
  updateArgs?: Record<string, unknown>,
): ModelSettings {
  const settings: Record<string, unknown> = { ...existingModelSettings };

  // Include our custom ChatGPT OAuth provider (chatgpt-plus-pro)
  const isOpenAI =
    modelHandle.startsWith("openai/") ||
    modelHandle.startsWith(`${OPENAI_CODEX_PROVIDER_NAME}/`);
  // Include legacy custom Anthropic OAuth provider (claude-pro-max)
  const isAnthropic =
    modelHandle.startsWith("anthropic/") ||
    modelHandle.startsWith("claude-pro-max/");
  const isZai = modelHandle.startsWith("zai/");
  const isGoogleAI = modelHandle.startsWith("google_ai/");
  const isGoogleVertex = modelHandle.startsWith("google_vertex/");
  const isOpenRouter = modelHandle.startsWith("openrouter/");
  const isBedrock = modelHandle.startsWith("bedrock/");

  const parallelToolCallsProvided =
    hasUpdateArg(updateArgs, "parallel_tool_calls") &&
    typeof updateArgs?.parallel_tool_calls === "boolean";

  const applyParallelToolCalls = () => {
    if (parallelToolCallsProvided) {
      settings.parallel_tool_calls = updateArgs?.parallel_tool_calls;
    }
  };

  if (isOpenAI || isOpenRouter) {
    settings.provider_type = "openai";
    applyParallelToolCalls();

    if (hasUpdateArg(updateArgs, "reasoning_effort")) {
      const effort = updateArgs?.reasoning_effort;
      if (
        effort === "none" ||
        effort === "minimal" ||
        effort === "low" ||
        effort === "medium" ||
        effort === "high" ||
        effort === "xhigh"
      ) {
        settings.reasoning = {
          ...(asRecord(settings.reasoning) ?? {}),
          reasoning_effort: effort as
            | "none"
            | "minimal"
            | "low"
            | "medium"
            | "high"
            | "xhigh",
        };
      }
    }

    if (hasUpdateArg(updateArgs, "verbosity")) {
      const verbosity = updateArgs?.verbosity;
      if (
        verbosity === "low" ||
        verbosity === "medium" ||
        verbosity === "high"
      ) {
        settings.verbosity = verbosity;
      }
    }

    if (hasUpdateArg(updateArgs, "max_output_tokens")) {
      if (typeof updateArgs?.max_output_tokens === "number") {
        settings.max_output_tokens = updateArgs.max_output_tokens;
      }
    }
  } else if (isAnthropic) {
    settings.provider_type = "anthropic";
    applyParallelToolCalls();

    // Map reasoning_effort to Anthropic's effort field
    if (hasUpdateArg(updateArgs, "reasoning_effort")) {
      const effort = updateArgs?.reasoning_effort;
      if (effort === "low" || effort === "medium" || effort === "high") {
        settings.effort = effort;
      } else if (effort === "xhigh") {
        // "max" is valid on the backend but the SDK type hasn't caught up yet
        settings.effort = "max";
      }
    }

    const hasEnableReasoner = hasUpdateArg(updateArgs, "enable_reasoner");
    const hasMaxReasoningTokens = hasUpdateArg(
      updateArgs,
      "max_reasoning_tokens",
    );
    if (hasEnableReasoner || hasMaxReasoningTokens) {
      const thinking = {
        ...(asRecord(settings.thinking) ?? {}),
      } as Record<string, unknown>;
      if (
        hasEnableReasoner &&
        typeof updateArgs?.enable_reasoner === "boolean"
      ) {
        thinking.type = updateArgs.enable_reasoner ? "enabled" : "disabled";
      }
      if (typeof updateArgs?.max_reasoning_tokens === "number") {
        thinking.budget_tokens = updateArgs.max_reasoning_tokens;
      }
      if (!thinking.type) {
        thinking.type = "enabled";
      }
      settings.thinking = thinking;
    }

    if (hasUpdateArg(updateArgs, "max_output_tokens")) {
      if (typeof updateArgs?.max_output_tokens === "number") {
        settings.max_output_tokens = updateArgs.max_output_tokens;
      }
    }
  } else if (isZai) {
    settings.provider_type = "zai";
    applyParallelToolCalls();
    if (hasUpdateArg(updateArgs, "max_output_tokens")) {
      if (typeof updateArgs?.max_output_tokens === "number") {
        settings.max_output_tokens = updateArgs.max_output_tokens;
      }
    }
  } else if (isGoogleAI) {
    settings.provider_type = "google_ai";
    applyParallelToolCalls();
    if (hasUpdateArg(updateArgs, "thinking_budget")) {
      settings.thinking_config = {
        ...(asRecord(settings.thinking_config) ?? {}),
        thinking_budget: updateArgs?.thinking_budget as number,
      };
    }
    if (hasUpdateArg(updateArgs, "temperature")) {
      if (typeof updateArgs?.temperature === "number") {
        settings.temperature = updateArgs.temperature;
      }
    }
    if (hasUpdateArg(updateArgs, "max_output_tokens")) {
      if (typeof updateArgs?.max_output_tokens === "number") {
        settings.max_output_tokens = updateArgs.max_output_tokens;
      }
    }
  } else if (isGoogleVertex) {
    settings.provider_type = "google_vertex";
    applyParallelToolCalls();
    if (hasUpdateArg(updateArgs, "thinking_budget")) {
      settings.thinking_config = {
        ...(asRecord(settings.thinking_config) ?? {}),
        thinking_budget: updateArgs?.thinking_budget as number,
      };
    }
    if (hasUpdateArg(updateArgs, "temperature")) {
      if (typeof updateArgs?.temperature === "number") {
        settings.temperature = updateArgs.temperature;
      }
    }
    if (hasUpdateArg(updateArgs, "max_output_tokens")) {
      if (typeof updateArgs?.max_output_tokens === "number") {
        settings.max_output_tokens = updateArgs.max_output_tokens;
      }
    }
  } else if (isBedrock) {
    settings.provider_type = "bedrock";
    applyParallelToolCalls();

    if (hasUpdateArg(updateArgs, "reasoning_effort")) {
      const effort = updateArgs?.reasoning_effort;
      if (effort === "low" || effort === "medium" || effort === "high") {
        settings.effort = effort;
      } else if (effort === "xhigh") {
        settings.effort = "max";
      }
    }

    const hasEnableReasoner = hasUpdateArg(updateArgs, "enable_reasoner");
    const hasMaxReasoningTokens = hasUpdateArg(
      updateArgs,
      "max_reasoning_tokens",
    );
    if (hasEnableReasoner || hasMaxReasoningTokens) {
      const thinking = {
        ...(asRecord(settings.thinking) ?? {}),
      } as Record<string, unknown>;
      if (
        hasEnableReasoner &&
        typeof updateArgs?.enable_reasoner === "boolean"
      ) {
        thinking.type = updateArgs.enable_reasoner ? "enabled" : "disabled";
      }
      if (typeof updateArgs?.max_reasoning_tokens === "number") {
        thinking.budget_tokens = updateArgs.max_reasoning_tokens;
      }
      if (!thinking.type) {
        thinking.type = "enabled";
      }
      settings.thinking = thinking;
    }

    if (hasUpdateArg(updateArgs, "max_output_tokens")) {
      if (typeof updateArgs?.max_output_tokens === "number") {
        settings.max_output_tokens = updateArgs.max_output_tokens;
      }
    }
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
 * @returns The updated agent state from the server (includes llm_config and model_settings)
 */
export async function updateAgentLLMConfig(
  agentId: string,
  modelHandle: string,
  updateArgs?: Record<string, unknown>,
): Promise<AgentState> {
  const client = await getClient();

  const currentAgent = await client.agents.retrieve(agentId);
  const currentModelSettings = asRecord(currentAgent.model_settings) ?? {};
  const modelSettings = buildModelSettings(
    modelHandle,
    currentModelSettings,
    updateArgs,
  );

  const hasModelSettings = Object.keys(modelSettings).length > 0;
  const hasContextWindowArg =
    hasUpdateArg(updateArgs, "context_window") &&
    typeof updateArgs?.context_window === "number";
  const hasMaxOutputTokensArg =
    hasUpdateArg(updateArgs, "max_output_tokens") &&
    typeof updateArgs?.max_output_tokens === "number";

  await client.agents.update(agentId, {
    model: modelHandle,
    ...(hasModelSettings && { model_settings: modelSettings }),
    ...(hasContextWindowArg && {
      context_window_limit: updateArgs.context_window as number,
    }),
    ...(hasMaxOutputTokensArg && {
      max_tokens: updateArgs.max_output_tokens,
    }),
  });

  const finalAgent = await client.agents.retrieve(agentId);
  return finalAgent;
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
    const { detectMemoryPromptDrift, reconcileMemoryPrompt } = await import(
      "./memoryPrompt"
    );
    const { settingsManager } = await import("../settings-manager");

    const client = await getClient();
    const currentAgent = await client.agents.retrieve(agentId);
    const baseContent = await resolveSystemPrompt(systemPromptId);

    const settingIndicatesMemfs = settingsManager.isMemfsEnabled(agentId);
    const promptIndicatesMemfs = detectMemoryPromptDrift(
      currentAgent.system || "",
      "standard",
    ).some((drift) => drift.code === "memfs_language_with_standard_mode");

    const memoryMode =
      settingIndicatesMemfs || promptIndicatesMemfs ? "memfs" : "standard";
    const systemPromptContent = reconcileMemoryPrompt(baseContent, memoryMode);

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

/**
 * Updates an agent's system prompt to swap between managed memory modes.
 *
 * Uses the shared memory prompt reconciler so we safely replace managed memory
 * sections without corrupting fenced code blocks or leaving orphan fragments.
 *
 * @param agentId - The agent ID to update
 * @param enableMemfs - Whether to enable (add) or disable (remove) the memfs addon
 * @returns Result with success status and message
 */
export async function updateAgentSystemPromptMemfs(
  agentId: string,
  enableMemfs: boolean,
): Promise<SystemPromptUpdateResult> {
  try {
    const client = await getClient();
    const agent = await client.agents.retrieve(agentId);
    const { reconcileMemoryPrompt } = await import("./memoryPrompt");

    const nextSystemPrompt = reconcileMemoryPrompt(
      agent.system || "",
      enableMemfs ? "memfs" : "standard",
    );

    await client.agents.update(agentId, {
      system: nextSystemPrompt,
    });

    return {
      success: true,
      message: enableMemfs
        ? "System prompt updated to include Memory Filesystem section"
        : "System prompt updated to include standard Memory section",
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to update system prompt memfs: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
