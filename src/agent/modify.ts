// src/agent/modify.ts
// Utilities for modifying agent configuration

import type {
  AgentState,
  AnthropicModelSettings,
  GoogleAIModelSettings,
  OpenAIModelSettings,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { OPENAI_CODEX_PROVIDER_NAME } from "../providers/openai-codex-provider";
import { getModelContextWindow } from "./available-models";
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
  // Include our custom ChatGPT OAuth provider (chatgpt-plus-pro)
  const isOpenAI =
    modelHandle.startsWith("openai/") ||
    modelHandle.startsWith(`${OPENAI_CODEX_PROVIDER_NAME}/`);
  // Include legacy custom Anthropic OAuth provider (claude-pro-max) and minimax
  const isAnthropic =
    modelHandle.startsWith("anthropic/") ||
    modelHandle.startsWith("claude-pro-max/") ||
    modelHandle.startsWith("minimax/");
  const isZai = modelHandle.startsWith("zai/");
  const isGoogleAI = modelHandle.startsWith("google_ai/");
  const isGoogleVertex = modelHandle.startsWith("google_vertex/");
  const isOpenRouter = modelHandle.startsWith("openrouter/");
  const isBedrock = modelHandle.startsWith("bedrock/");

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
          | "high"
          | "xhigh",
      };
    }
    const verbosity = updateArgs?.verbosity;
    if (verbosity === "low" || verbosity === "medium" || verbosity === "high") {
      // The backend supports verbosity for OpenAI-family providers; the generated
      // client type may lag this field, so set it via a narrow record cast.
      (openaiSettings as Record<string, unknown>).verbosity = verbosity;
    }
    if (typeof updateArgs?.strict === "boolean") {
      openaiSettings.strict = updateArgs.strict;
    }
    settings = openaiSettings;
  } else if (isAnthropic) {
    const anthropicSettings: AnthropicModelSettings = {
      provider_type: "anthropic",
      parallel_tool_calls: true,
    };
    // Map reasoning_effort to Anthropic's effort field (controls token spending via output_config)
    const effort = updateArgs?.reasoning_effort;
    if (effort === "low" || effort === "medium" || effort === "high") {
      anthropicSettings.effort = effort;
    } else if (effort === "xhigh") {
      // "max" is valid on the backend but the SDK type hasn't caught up yet
      (anthropicSettings as Record<string, unknown>).effort = "max";
    }
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
    if (typeof updateArgs?.strict === "boolean") {
      (anthropicSettings as Record<string, unknown>).strict = updateArgs.strict;
    }
    settings = anthropicSettings;
  } else if (isZai) {
    // Zai uses the same model_settings structure as other providers.
    // Ensure parallel_tool_calls is enabled.
    settings = {
      provider_type: "zai",
      parallel_tool_calls: true,
    };
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
  } else if (isBedrock) {
    // AWS Bedrock - supports Anthropic Claude models with thinking config
    const bedrockSettings: Record<string, unknown> = {
      provider_type: "bedrock",
      parallel_tool_calls: true,
    };
    // Map reasoning_effort to Anthropic's effort field (Bedrock runs Claude models)
    const effort = updateArgs?.reasoning_effort;
    if (effort === "low" || effort === "medium" || effort === "high") {
      bedrockSettings.effort = effort;
    } else if (effort === "xhigh") {
      bedrockSettings.effort = "max";
    }
    // Build thinking config if either enable_reasoner or max_reasoning_tokens is specified
    if (
      updateArgs?.enable_reasoner !== undefined ||
      typeof updateArgs?.max_reasoning_tokens === "number"
    ) {
      bedrockSettings.thinking = {
        type: updateArgs?.enable_reasoner === false ? "disabled" : "enabled",
        ...(typeof updateArgs?.max_reasoning_tokens === "number" && {
          budget_tokens: updateArgs.max_reasoning_tokens,
        }),
      };
    }
    settings = bedrockSettings;
  } else {
    // Unknown/BYOK providers (e.g. openai-proxy) — assume OpenAI-compatible
    const openaiProxySettings: OpenAIModelSettings = {
      provider_type: "openai",
      parallel_tool_calls:
        typeof updateArgs?.parallel_tool_calls === "boolean"
          ? updateArgs.parallel_tool_calls
          : true,
    };
    if (typeof updateArgs?.strict === "boolean") {
      (openaiProxySettings as Record<string, unknown>).strict =
        updateArgs.strict;
    }
    settings = openaiProxySettings;
  }

  // Apply max_output_tokens only when provider_type is present and the value
  // is a concrete number.  Null means "unset" and should only be forwarded via
  // the top-level max_tokens field — some providers (e.g. OpenAI) reject null
  // inside their typed model_settings.
  if (
    typeof updateArgs?.max_output_tokens === "number" &&
    "provider_type" in settings
  ) {
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
 * @param options - Optional update behavior overrides
 * @returns The updated agent state from the server (includes llm_config and model_settings)
 */
export interface UpdateAgentLLMConfigOptions {
  preserveContextWindow?: boolean;
}

export async function updateAgentLLMConfig(
  agentId: string,
  modelHandle: string,
  updateArgs?: Record<string, unknown>,
  options?: UpdateAgentLLMConfigOptions,
): Promise<AgentState> {
  const client = await getClient();

  const modelSettings = buildModelSettings(modelHandle, updateArgs);
  const explicitContextWindow = updateArgs?.context_window as
    | number
    | undefined;
  const shouldPreserveContextWindow = options?.preserveContextWindow === true;
  // Resume refresh updates should not implicitly reset context window.
  const contextWindow =
    explicitContextWindow ??
    (!shouldPreserveContextWindow
      ? await getModelContextWindow(modelHandle)
      : undefined);
  const hasModelSettings = Object.keys(modelSettings).length > 0;

  await client.agents.update(agentId, {
    model: modelHandle,
    ...(hasModelSettings && { model_settings: modelSettings }),
    ...(contextWindow && { context_window_limit: contextWindow }),
    ...((typeof updateArgs?.max_output_tokens === "number" ||
      updateArgs?.max_output_tokens === null) && {
      max_tokens: updateArgs.max_output_tokens,
    }),
  });

  const finalAgent = await client.agents.retrieve(agentId);
  return finalAgent;
}

/**
 * Updates a conversation's model and model settings.
 *
 * Uses conversation-scoped model overrides so different conversations can
 * run with different models without mutating the agent's default model.
 *
 * @param conversationId - The conversation ID (or "default")
 * @param modelHandle - The model handle (e.g., "anthropic/claude-sonnet-4-5-20250929")
 * @param updateArgs - Additional config args (reasoning_effort, enable_reasoner, etc.)
 * @returns The updated conversation from the server
 */
export async function updateConversationLLMConfig(
  conversationId: string,
  modelHandle: string,
  updateArgs?: Record<string, unknown>,
): Promise<Conversation> {
  const client = await getClient();

  const modelSettings = buildModelSettings(modelHandle, updateArgs);
  const hasModelSettings = Object.keys(modelSettings).length > 0;
  const payload = {
    model: modelHandle,
    ...(hasModelSettings && { model_settings: modelSettings }),
  } as unknown as Parameters<typeof client.conversations.update>[1];

  return client.conversations.update(conversationId, payload);
}

/**
 * Recompile an agent's system prompt after memory writes so server-side prompt
 * state picks up the latest memory content.
 *
 * @param conversationId - The conversation whose prompt should be recompiled
 * @param agentId - Agent id for the parent conversation
 * @param dryRun - Optional dry-run control
 * @param clientOverride - Optional injected client for tests
 * @returns The compiled system prompt returned by the API
 */
export async function recompileAgentSystemPrompt(
  conversationId: string,
  agentId: string,
  dryRun?: boolean,
  clientOverride?: {
    conversations: {
      recompile: (
        conversationId: string,
        params: {
          dry_run?: boolean;
          agent_id?: string;
        },
      ) => Promise<string>;
    };
  },
): Promise<string> {
  const client = (clientOverride ?? (await getClient())) as Exclude<
    typeof clientOverride,
    undefined
  >;

  if (!agentId) {
    throw new Error("recompileAgentSystemPrompt requires agentId");
  }

  const params = {
    dry_run: dryRun,
    agent_id: agentId,
  };

  return client.conversations.recompile(conversationId, params);
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
    const { isKnownPreset, resolveAndBuildSystemPrompt } = await import(
      "./promptAssets"
    );
    const { settingsManager } = await import("../settings-manager");

    const client = await getClient();
    const memoryMode =
      settingsManager.isReady && settingsManager.isMemfsEnabled(agentId)
        ? "memfs"
        : "standard";

    const systemPromptContent = await resolveAndBuildSystemPrompt(
      systemPromptId,
      memoryMode,
    );

    console.debug("[modify] systemPromptContent:", systemPromptContent);

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

    // Persist preset for known presets; clear stale preset for subagent/unknown
    if (settingsManager.isReady) {
      if (isKnownPreset(systemPromptId)) {
        settingsManager.setSystemPromptPreset(agentId, systemPromptId);
      } else {
        settingsManager.clearSystemPromptPreset(agentId);
      }
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
    const { settingsManager } = await import("../settings-manager");
    const { isKnownPreset, buildSystemPrompt, swapMemoryAddon } = await import(
      "./promptAssets"
    );

    const newMode = enableMemfs ? "memfs" : "standard";
    const storedPreset = settingsManager.isReady
      ? settingsManager.getSystemPromptPreset(agentId)
      : undefined;

    let nextSystemPrompt: string;
    if (storedPreset && isKnownPreset(storedPreset)) {
      nextSystemPrompt = buildSystemPrompt(storedPreset, newMode);
    } else {
      const client = await getClient();
      const agent = await client.agents.retrieve(agentId);
      nextSystemPrompt = swapMemoryAddon(agent.system || "", newMode);
    }

    const client = await getClient();
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
