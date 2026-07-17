// src/agent/modify.ts
// Utilities for modifying agent configuration

import type {
  AgentState,
  AnthropicModelSettings,
  GoogleAIModelSettings,
  OpenAIModelSettings,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type { Backend } from "@/backend";
import { getBackend } from "@/backend";
import { OPENAI_CODEX_PROVIDER_NAME } from "@/providers/openai-codex-provider";
import { debugLog } from "@/utils/debug";
import { isRecord } from "@/utils/type-guards";
import { getModelContextWindow } from "./available-models";
import { getModelInfo, type ModelReasoningEffort } from "./model";

type ModelSettings =
  | OpenAIModelSettings
  | AnthropicModelSettings
  | GoogleAIModelSettings
  | Record<string, unknown>;

function supportsDistinctAnthropicXHighEffort(modelHandle: string): boolean {
  return (
    modelHandle.includes("claude-fable-5") ||
    modelHandle.includes("claude-opus-4-7") ||
    modelHandle.includes("claude-opus-4-8")
  );
}

/**
 * Builds model_settings from updateArgs based on provider type.
 * Always ensures parallel_tool_calls is enabled.
 */
function buildModelSettings(
  modelHandle: string,
  updateArgs?: Record<string, unknown>,
): ModelSettings {
  const explicitProviderType =
    typeof updateArgs?.provider_type === "string"
      ? updateArgs.provider_type
      : undefined;
  // Include ChatGPT OAuth/Codex providers, including user-defined aliases whose
  // provider_type is supplied by the server model catalog.
  const isOpenAICodex =
    explicitProviderType === "chatgpt_oauth" ||
    modelHandle.startsWith("openai-codex/");
  const isOpenAI =
    explicitProviderType === "openai" ||
    modelHandle.startsWith("openai/") ||
    isOpenAICodex ||
    modelHandle.startsWith(`${OPENAI_CODEX_PROVIDER_NAME}/`);
  // Include legacy custom Anthropic OAuth provider (claude-pro-max) and minimax
  const isAnthropic =
    explicitProviderType === "anthropic" ||
    modelHandle.startsWith("anthropic/") ||
    modelHandle.startsWith("lc-anthropic/") ||
    modelHandle.startsWith("claude-pro-max/") ||
    modelHandle.startsWith("minimax/");
  const isMoonshot =
    explicitProviderType === "moonshot" ||
    explicitProviderType === "moonshotai" ||
    modelHandle.startsWith("moonshot/") ||
    modelHandle.startsWith("moonshotai/");
  const isZai =
    explicitProviderType === "zai" || modelHandle.startsWith("zai/");
  const isXai =
    explicitProviderType === "xai" || modelHandle.startsWith("xai/");
  const isGoogleAI =
    explicitProviderType === "google_ai" ||
    modelHandle.startsWith("google_ai/");
  const isGoogleVertex =
    explicitProviderType === "google_vertex" ||
    modelHandle.startsWith("google_vertex/");
  const isOpenRouter =
    explicitProviderType === "openrouter" ||
    modelHandle.startsWith("openrouter/");
  const isBedrock =
    explicitProviderType === "bedrock" || modelHandle.startsWith("bedrock/");

  let settings: ModelSettings;

  if (isMoonshot) {
    const moonshotSettings: Record<string, unknown> = {
      provider_type: "moonshot",
      parallel_tool_calls: true,
    };
    if (typeof updateArgs?.reasoning_effort === "string") {
      moonshotSettings.reasoning_effort = updateArgs.reasoning_effort;
    }
    settings = moonshotSettings;
  } else if (isOpenAI || isOpenRouter) {
    const openaiSettings: OpenAIModelSettings = {
      provider_type: "openai",
      parallel_tool_calls: true,
    };
    if (isOpenAICodex) {
      (openaiSettings as Record<string, unknown>).provider_type =
        "chatgpt_oauth";
    }
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
    if (updateArgs && "service_tier" in updateArgs) {
      (openaiSettings as Record<string, unknown>).service_tier =
        updateArgs.service_tier === "priority" ? "priority" : null;
    }
    settings = openaiSettings;
  } else if (isAnthropic) {
    const anthropicSettings: AnthropicModelSettings = {
      provider_type: "anthropic",
      parallel_tool_calls: true,
    };
    // Map reasoning_effort to Anthropic's effort field (controls token spending via output_config)
    const effort = updateArgs?.reasoning_effort;
    const hasDistinctXHigh = supportsDistinctAnthropicXHighEffort(modelHandle);
    if (effort === "low" || effort === "medium" || effort === "high") {
      anthropicSettings.effort = effort;
    } else if (effort === "xhigh") {
      // "xhigh" is distinct on Fable and Opus 4.7+; older Anthropic models map it to backend "max".
      (anthropicSettings as Record<string, unknown>).effort = hasDistinctXHigh
        ? "xhigh"
        : "max";
    } else if (effort === "max") {
      // "max" is valid on the backend but the SDK type hasn't caught up yet
      (anthropicSettings as Record<string, unknown>).effort = effort;
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
  } else if (isXai) {
    // xAI is OpenAI-compatible on the wire, but direct xAI handles must route
    // through provider_type=xai instead of the generic OpenAI fallback.
    settings = {
      provider_type: "xai",
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
    const hasDistinctXHigh = supportsDistinctAnthropicXHighEffort(modelHandle);
    if (effort === "low" || effort === "medium" || effort === "high") {
      bedrockSettings.effort = effort;
    } else if (effort === "xhigh") {
      bedrockSettings.effort = hasDistinctXHigh ? "xhigh" : "max";
    } else if (effort === "max") {
      bedrockSettings.effort = effort;
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
    if (updateArgs?.reasoning_effort) {
      openaiProxySettings.reasoning = {
        reasoning_effort: updateArgs.reasoning_effort as
          | "none"
          | "minimal"
          | "low"
          | "medium"
          | "high"
          | "xhigh",
      };
    }
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

  // Preserve OpenCode-style modality metadata when present so local-model
  // transforms can decide whether file/image parts are safe to send.
  if (isRecord(updateArgs?.modalities)) {
    (settings as Record<string, unknown>).modalities = updateArgs.modalities;
  }
  if (isRecord(updateArgs?.capabilities)) {
    (settings as Record<string, unknown>).capabilities =
      updateArgs.capabilities;
  }

  return settings;
}

export const __modifyTestUtils = {
  buildModelSettings,
};

function updateArgsForModelSettings(
  updateArgs: Record<string, unknown> | undefined,
  options: { useBackendModelCatalog: boolean },
): Record<string, unknown> | undefined {
  if (!options.useBackendModelCatalog || !updateArgs) return updateArgs;
  return Object.fromEntries(
    Object.entries(updateArgs).filter(([key]) => key !== "max_output_tokens"),
  );
}

function maxTokensForUpdatePayload(
  updateArgs: Record<string, unknown> | undefined,
  options: { useBackendModelCatalog: boolean },
): number | null | undefined {
  if (options.useBackendModelCatalog) return undefined;
  const maxTokens = updateArgs?.max_output_tokens;
  return typeof maxTokens === "number" || maxTokens === null
    ? maxTokens
    : undefined;
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
export interface UpdateLLMConfigOptions {
  /**
   * Context window to send explicitly. Wins over updateArgs.context_window
   * and catalog derivation on EVERY backend — including local backends, where
   * updateArgs.context_window is otherwise ignored in favor of the pi model
   * catalog. Preserve paths (reasoning cycles, resume refresh, conversation
   * carryover, same-variant /model changes) use this to re-send the current
   * window (LET-9786).
   */
  contextWindowOverride?: number;
}

/**
 * Resolve the context window to send with a model-bearing update.
 *
 * Always produces a value when one is knowable. The server treats an omitted
 * context_window_limit as "re-derive from the handle", which clamps to a
 * legacy 128k global default (LET-9786) — so omission is never a preserve
 * mechanism. Resolution order:
 *  1. options.contextWindowOverride (preserve paths; all backends)
 *  2. updateArgs.context_window (catalog presets; API backends only — local
 *     backends own token limits via the pi catalog)
 *  3. models API listing for the handle
 *  4. registry preset for the handle (API backends)
 *  5. the current server-side value, re-sent as-is (API backends; last resort
 *     for uncatalogued/custom handles so the field is still not omitted)
 */
async function resolveContextWindowForUpdate(params: {
  modelHandle: string;
  updateArgs?: Record<string, unknown>;
  options?: UpdateLLMConfigOptions;
  useBackendModelCatalog: boolean;
  fetchCurrent: () => Promise<number | undefined>;
}): Promise<number | undefined> {
  const { modelHandle, updateArgs, options, useBackendModelCatalog } = params;
  if (typeof options?.contextWindowOverride === "number") {
    return options.contextWindowOverride;
  }
  const presetContextWindow = useBackendModelCatalog
    ? undefined
    : (updateArgs?.context_window as number | undefined);
  if (typeof presetContextWindow === "number") {
    return presetContextWindow;
  }
  const catalogContextWindow = await getModelContextWindow(modelHandle);
  if (typeof catalogContextWindow === "number") {
    return catalogContextWindow;
  }
  if (useBackendModelCatalog) {
    // Local backends derive token limits from the pi catalog server-side and
    // treat an omitted value as "keep current"; no clamp exists there.
    return undefined;
  }
  const registryContextWindow = (
    getModelInfo(modelHandle)?.updateArgs as
      | { context_window?: number }
      | null
      | undefined
  )?.context_window;
  if (typeof registryContextWindow === "number") {
    return registryContextWindow;
  }
  return params.fetchCurrent();
}

function contextWindowFromEntityRecord(entity: unknown): number | undefined {
  if (!isRecord(entity)) return undefined;
  if (typeof entity.context_window_limit === "number") {
    return entity.context_window_limit;
  }
  const llmConfig = entity.llm_config;
  if (isRecord(llmConfig) && typeof llmConfig.context_window === "number") {
    return llmConfig.context_window;
  }
  return undefined;
}

export async function updateAgentLLMConfig(
  agentId: string,
  modelHandle: string,
  updateArgs?: Record<string, unknown>,
  options?: UpdateLLMConfigOptions,
): Promise<AgentState> {
  const backend = getBackend();
  const useBackendModelCatalog = backend.capabilities.localModelCatalog;

  const modelSettings = buildModelSettings(
    modelHandle,
    updateArgsForModelSettings(updateArgs, { useBackendModelCatalog }),
  );
  const contextWindow = await resolveContextWindowForUpdate({
    modelHandle,
    updateArgs,
    options,
    useBackendModelCatalog,
    fetchCurrent: async () =>
      contextWindowFromEntityRecord(await backend.retrieveAgent(agentId)),
  });
  const hasModelSettings = Object.keys(modelSettings).length > 0;
  const maxTokens = maxTokensForUpdatePayload(updateArgs, {
    useBackendModelCatalog,
  });

  await backend.updateAgent(agentId, {
    model: modelHandle,
    ...(hasModelSettings && { model_settings: modelSettings }),
    ...(contextWindow && { context_window_limit: contextWindow }),
    ...(maxTokens !== undefined && { max_tokens: maxTokens }),
  });

  const finalAgent = await backend.retrieveAgent(agentId, {
    include: ["agent.secrets", "agent.tools", "agent.tags"],
  });
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
  options?: UpdateLLMConfigOptions,
): Promise<Conversation> {
  const backend = getBackend();
  const useBackendModelCatalog = backend.capabilities.localModelCatalog;

  const modelSettings = buildModelSettings(
    modelHandle,
    updateArgsForModelSettings(updateArgs, { useBackendModelCatalog }),
  );
  const contextWindow = await resolveContextWindowForUpdate({
    modelHandle,
    updateArgs,
    options,
    useBackendModelCatalog,
    fetchCurrent: async () =>
      contextWindowFromEntityRecord(
        await backend.retrieveConversation(conversationId),
      ),
  });
  const hasModelSettings = Object.keys(modelSettings).length > 0;
  const maxTokens = maxTokensForUpdatePayload(updateArgs, {
    useBackendModelCatalog,
  });
  const payload = {
    model: modelHandle,
    ...(hasModelSettings && { model_settings: modelSettings }),
    ...(contextWindow && { context_window_limit: contextWindow }),
    ...(maxTokens !== undefined && { max_tokens: maxTokens }),
  } as Parameters<typeof backend.updateConversation>[1];

  return backend.updateConversation(conversationId, payload);
}

export interface ModelConfigUpdate {
  /** Model handle, e.g. "anthropic/claude-opus-4-8". Omit to keep the current model. */
  model?: string;
  /** Reasoning effort tier. Omit to leave reasoning settings untouched. */
  reasoningEffort?: ModelReasoningEffort;
  /** Context window limit. Omit to leave the current limit untouched. */
  contextWindow?: number;
}

export type ModelConfigTarget =
  | { scope: "agent"; agentId: string }
  | { scope: "conversation"; conversationId: string; agentId?: string | null };

function modelHandleFromLlmConfig(
  llmConfig:
    | { model?: string | null; model_endpoint_type?: string | null }
    | null
    | undefined,
): string | null {
  if (!llmConfig) return null;
  if (llmConfig.model_endpoint_type && llmConfig.model) {
    return `${llmConfig.model_endpoint_type}/${llmConfig.model}`;
  }
  return llmConfig.model ?? null;
}

async function resolveAgentModelHandle(
  backend: Backend,
  agentId: string,
): Promise<string | null> {
  const agent = await backend.retrieveAgent(agentId);
  if (typeof agent.model === "string" && agent.model.length > 0) {
    return agent.model;
  }
  return modelHandleFromLlmConfig(agent.llm_config);
}

async function resolveCurrentModelHandle(
  backend: Backend,
  target: ModelConfigTarget,
): Promise<string | null> {
  if (target.scope === "agent") {
    return resolveAgentModelHandle(backend, target.agentId);
  }
  if (target.conversationId !== "default") {
    const conversation = await backend.retrieveConversation(
      target.conversationId,
    );
    const conversationModel = (conversation as { model?: unknown }).model;
    if (typeof conversationModel === "string" && conversationModel.length > 0) {
      return conversationModel;
    }
  }
  return target.agentId
    ? resolveAgentModelHandle(backend, target.agentId)
    : null;
}

/**
 * Applies a partial model-config update (model, reasoning effort, and/or context
 * window) without rebuilding settings the caller did not touch.
 *
 * - Only `contextWindow`: sends `context_window_limit` alone, preserving the
 *   current model and model_settings (including reasoning effort).
 * - `reasoningEffort` without `model`: resolves the current model handle so
 *   model_settings can be rebuilt for the right provider.
 * - `model` (with optional effort/context): rebuilds model_settings and derives
 *   a context window when one is not supplied, matching updateAgentLLMConfig.
 *
 * Routes through the supplied backend's updateAgent/updateConversation, so it
 * works for both local and constellation agents.
 */
export async function updateModelConfig(
  backend: Backend,
  target: ModelConfigTarget,
  update: ModelConfigUpdate,
): Promise<void> {
  const touchesModelSettings =
    update.model !== undefined || update.reasoningEffort !== undefined;

  let modelHandle = update.model;
  if (touchesModelSettings && !modelHandle) {
    modelHandle =
      (await resolveCurrentModelHandle(backend, target)) ?? undefined;
    if (!modelHandle) {
      throw new Error(
        "updateModelConfig: cannot change reasoning effort because the current model could not be resolved",
      );
    }
  }

  const useBackendModelCatalog = backend.capabilities.localModelCatalog;
  const updateArgs =
    update.reasoningEffort !== undefined
      ? { reasoning_effort: update.reasoningEffort }
      : undefined;

  const modelSettings =
    touchesModelSettings && modelHandle
      ? buildModelSettings(
          modelHandle,
          updateArgsForModelSettings(updateArgs, { useBackendModelCatalog }),
        )
      : undefined;
  const hasModelSettings =
    modelSettings !== undefined && Object.keys(modelSettings).length > 0;

  // Honor an explicit context window regardless of catalog mode; only derive a
  // default (on model change) when the backend does not own the catalog.
  const contextWindow =
    update.contextWindow ??
    (update.model !== undefined && !useBackendModelCatalog
      ? await getModelContextWindow(update.model)
      : undefined);

  const patch = {
    ...(update.model !== undefined && { model: update.model }),
    ...(hasModelSettings && { model_settings: modelSettings }),
    ...(contextWindow !== undefined && { context_window_limit: contextWindow }),
  };

  if (Object.keys(patch).length === 0) return;

  if (target.scope === "agent") {
    await backend.updateAgent(
      target.agentId,
      patch as Parameters<typeof backend.updateAgent>[1],
    );
  } else {
    await backend.updateConversation(
      target.conversationId,
      patch as Parameters<typeof backend.updateConversation>[1],
    );
  }
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
  const backend = getBackend();
  if (!clientOverride && !backend.capabilities.promptRecompile) {
    throw new Error(
      "Server-side prompt recompile is not supported by this backend yet",
    );
  }

  if (!agentId) {
    throw new Error("recompileAgentSystemPrompt requires agentId");
  }

  const params = {
    dry_run: dryRun,
    agent_id: agentId,
  };

  if (clientOverride) {
    return clientOverride.conversations.recompile(conversationId, params);
  }

  return backend.recompileConversation(conversationId, params);
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
    await getBackend().updateAgent(agentId, {
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
 * @param systemPromptId - System prompt ID (e.g., "codex") or subagent name (e.g., "recall")
 * @returns Result with success status, message, and updated agent state
 */
export async function updateAgentSystemPrompt(
  agentId: string,
  systemPromptId: string,
): Promise<UpdateSystemPromptResult> {
  try {
    const { isKnownPreset } = await import("@/agent/prompt-assets");
    const { resolveAndBuildSystemPrompt } = await import(
      "@/agent/system-prompt-resolution"
    );
    const { recordManagedSystemPrompt } = await import(
      "@/agent/system-prompt-versioning"
    );
    const { settingsManager } = await import("@/settings-manager");

    const backend = getBackend();
    const memoryMode = backend.capabilities.localMemfs
      ? "local-memfs"
      : settingsManager.isReady && settingsManager.isMemfsEnabled(agentId)
        ? "memfs"
        : "standard";

    const systemPromptContent = await resolveAndBuildSystemPrompt(
      systemPromptId,
      memoryMode,
    );

    debugLog("modify", "systemPromptContent: %s", systemPromptContent);

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
        recordManagedSystemPrompt(
          agentId,
          systemPromptId,
          memoryMode,
          systemPromptContent,
        );
      } else {
        settingsManager.clearSystemPromptPreset(agentId);
      }
    }

    // Re-fetch agent to get updated state (include relationships so
    // callers that rely on agent.tags/tools/secrets aren't broken).
    const agent = await backend.retrieveAgent(agentId, {
      include: ["agent.secrets", "agent.tools", "agent.tags"],
    });

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
 * Updates an agent's system prompt to the memfs full-prompt variant when
 * the stored managed prompt hash is known. Custom prompts are already complete
 * and are left unchanged.
 *
 * MemFS cannot be disabled, so there is no path back to the standard variant.
 *
 * @param agentId - The agent ID to update
 * @returns Result with success status and message
 */
export async function updateAgentSystemPromptMemfs(
  agentId: string,
): Promise<SystemPromptUpdateResult> {
  try {
    const { settingsManager } = await import("@/settings-manager");
    const { isKnownPreset, buildSystemPrompt } = await import(
      "@/agent/prompt-assets"
    );
    const { hashSystemPrompt, recordManagedSystemPrompt } = await import(
      "@/agent/system-prompt-versioning"
    );

    const newMode = getBackend().capabilities.localMemfs
      ? "local-memfs"
      : "memfs";
    const storedPreset = settingsManager.isReady
      ? settingsManager.getSystemPromptPreset(agentId)
      : undefined;
    const storedHash = settingsManager.isReady
      ? settingsManager.getSystemPromptHash(agentId)
      : undefined;

    let nextSystemPrompt: string;
    if (storedPreset && isKnownPreset(storedPreset)) {
      const agent = await getBackend().retrieveAgent(agentId);
      const currentSystemPrompt = agent.system || "";
      if (storedHash && hashSystemPrompt(currentSystemPrompt) !== storedHash) {
        if (settingsManager.isReady) {
          settingsManager.setSystemPromptCustom(agentId);
        }
        return {
          success: true,
          message: "Custom system prompt left unchanged for memory mode",
        };
      }

      if (!storedHash && settingsManager.isReady) {
        const currentMode = settingsManager.isMemfsEnabled(agentId)
          ? getBackend().capabilities.localMemfs
            ? "local-memfs"
            : "memfs"
          : "standard";
        if (
          currentSystemPrompt !== buildSystemPrompt(storedPreset, currentMode)
        ) {
          settingsManager.setSystemPromptCustom(agentId);
          return {
            success: true,
            message: "Custom system prompt left unchanged for memory mode",
          };
        }
      }

      nextSystemPrompt = buildSystemPrompt(storedPreset, newMode);
    } else {
      const agent = await getBackend().retrieveAgent(agentId);
      nextSystemPrompt = agent.system || "";
    }

    await getBackend().updateAgent(agentId, {
      system: nextSystemPrompt,
    });

    if (storedPreset && isKnownPreset(storedPreset)) {
      recordManagedSystemPrompt(
        agentId,
        storedPreset,
        newMode,
        nextSystemPrompt,
      );
    }

    return {
      success: true,
      message: "System prompt updated for memfs memory mode",
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to update system prompt memfs: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
