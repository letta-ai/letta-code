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
import { OPENAI_COMPATIBLE_PROXY_UPDATE_ARG } from "@/utils/openai-endpoint";
import { normalizeReasoningEffortForModel } from "@/utils/openai-reasoning-effort";
import { isRecord } from "@/utils/type-guards";
import { getModelContextWindow } from "./available-models";
import { getModelInfo, type ModelReasoningSelection } from "./model";

type ModelSettings =
  | OpenAIModelSettings
  | AnthropicModelSettings
  | GoogleAIModelSettings
  | Record<string, unknown>;

function supportsDistinctAnthropicXHighEffort(modelHandle: string): boolean {
  return (
    modelHandle.includes("claude-fable-5") ||
    modelHandle.includes("claude-opus-5") ||
    modelHandle.includes("claude-sonnet-5") ||
    modelHandle.includes("claude-opus-4-7") ||
    modelHandle.includes("claude-opus-4-8")
  );
}

export function buildModelSettings(
  modelHandle: string,
  updateArgs?: Record<string, unknown>,
  localModelCatalog = false,
): ModelSettings {
  const explicitProviderType =
    typeof updateArgs?.provider_type === "string"
      ? updateArgs.provider_type
      : undefined;
  const isOpenAICodex =
    explicitProviderType === "chatgpt_oauth" ||
    modelHandle.startsWith("openai-codex/");
  const isOpenAI =
    explicitProviderType === "openai" ||
    modelHandle.startsWith("openai/") ||
    isOpenAICodex ||
    modelHandle.startsWith(`${OPENAI_CODEX_PROVIDER_NAME}/`);
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
      provider_type: isOpenRouter ? "openrouter" : "openai",
      parallel_tool_calls: true,
    } as OpenAIModelSettings;
    if (isOpenAICodex) {
      (openaiSettings as Record<string, unknown>).provider_type =
        "chatgpt_oauth";
    }
    if (updateArgs && "reasoning_effort" in updateArgs) {
      (openaiSettings as Record<string, unknown>).reasoning =
        updateArgs.reasoning_effort === null
          ? null
          : {
              reasoning_effort: normalizeReasoningEffortForModel(
                modelHandle,
                String(updateArgs.reasoning_effort),
              ),
            };
    }
    const verbosity = updateArgs?.verbosity;
    if (verbosity === "low" || verbosity === "medium" || verbosity === "high") {
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
    const effort = updateArgs?.reasoning_effort;
    const hasDistinctXHigh = supportsDistinctAnthropicXHighEffort(modelHandle);
    if (effort === "low" || effort === "medium" || effort === "high") {
      anthropicSettings.effort = effort;
    } else if (effort === "xhigh") {
      (anthropicSettings as Record<string, unknown>).effort = hasDistinctXHigh
        ? "xhigh"
        : "max";
    } else if (effort === "max") {
      (anthropicSettings as Record<string, unknown>).effort = effort;
    }
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
    settings = {
      provider_type: "zai",
      parallel_tool_calls: true,
      ...(typeof updateArgs?.reasoning_effort === "string" && {
        reasoning_effort: updateArgs.reasoning_effort,
      }),
    };
  } else if (isXai) {
    const xaiSettings: Record<string, unknown> = {
      provider_type: "xai",
      parallel_tool_calls: true,
    };
    if (updateArgs && "reasoning_effort" in updateArgs) {
      xaiSettings.reasoning =
        updateArgs.reasoning_effort === null
          ? null
          : { reasoning_effort: String(updateArgs.reasoning_effort) };
    }
    settings = xaiSettings as ModelSettings;
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
    const bedrockSettings: Record<string, unknown> = {
      provider_type: "bedrock",
      parallel_tool_calls: true,
    };
    const effort = updateArgs?.reasoning_effort;
    const hasDistinctXHigh = supportsDistinctAnthropicXHighEffort(modelHandle);
    if (effort === "low" || effort === "medium" || effort === "high") {
      bedrockSettings.effort = effort;
    } else if (effort === "xhigh") {
      bedrockSettings.effort = hasDistinctXHigh ? "xhigh" : "max";
    } else if (effort === "max") {
      bedrockSettings.effort = effort;
    }
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
    const openaiProxySettings = {
      provider_type: explicitProviderType ?? "openai",
      parallel_tool_calls:
        typeof updateArgs?.parallel_tool_calls === "boolean"
          ? updateArgs.parallel_tool_calls
          : true,
    } as OpenAIModelSettings;
    if (updateArgs && "reasoning_effort" in updateArgs) {
      (openaiProxySettings as Record<string, unknown>).reasoning =
        updateArgs.reasoning_effort === null
          ? null
          : {
              reasoning_effort: normalizeReasoningEffortForModel(
                modelHandle,
                String(updateArgs.reasoning_effort),
              ),
            };
    }
    if (typeof updateArgs?.strict === "boolean") {
      (openaiProxySettings as Record<string, unknown>).strict =
        updateArgs.strict;
    }
    settings = openaiProxySettings;
  }

  if (
    typeof updateArgs?.max_output_tokens === "number" &&
    "provider_type" in settings
  ) {
    (settings as Record<string, unknown>).max_output_tokens =
      updateArgs.max_output_tokens;
  }

  if (isRecord(updateArgs?.modalities)) {
    (settings as Record<string, unknown>).modalities = updateArgs.modalities;
  }
  if (isRecord(updateArgs?.capabilities)) {
    (settings as Record<string, unknown>).capabilities =
      updateArgs.capabilities;
  }

  if (
    localModelCatalog &&
    (typeof updateArgs?.reasoning_effort === "string" ||
      updateArgs?.reasoning_effort === null)
  ) {
    (settings as Record<string, unknown>).reasoning_effort =
      updateArgs.reasoning_effort;
  }
  if (localModelCatalog && isRecord(updateArgs?.sampling_params)) {
    (settings as Record<string, unknown>).sampling_params =
      updateArgs.sampling_params;
  }
  return settings;
}

export const __modifyTestUtils = {
  buildModelSettings,
  updateArgsForModelSettings,
};

function updateArgsForModelSettings(
  updateArgs: Record<string, unknown> | undefined,
  options: { useBackendModelCatalog: boolean },
): Record<string, unknown> | undefined {
  if (!updateArgs) return updateArgs;
  return Object.fromEntries(
    Object.entries(updateArgs).filter(
      ([key]) =>
        key !== OPENAI_COMPATIBLE_PROXY_UPDATE_ARG &&
        (!options.useBackendModelCatalog || key !== "max_output_tokens"),
    ),
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

export interface UpdateLLMConfigOptions {
  signal?: AbortSignal;
  contextWindowOverride?: number;
}

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
    useBackendModelCatalog,
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

  options?.signal?.throwIfAborted();
  await backend.updateAgent(
    agentId,
    {
      model: modelHandle,
      ...(hasModelSettings && { model_settings: modelSettings }),
      ...(contextWindow && { context_window_limit: contextWindow }),
      ...(maxTokens !== undefined && { max_tokens: maxTokens }),
    },
    ...(options?.signal ? [{ signal: options.signal }] : []),
  );

  const finalAgent = await backend.retrieveAgent(agentId, {
    include: ["agent.tools", "agent.tags"],
  });
  return finalAgent;
}

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
    useBackendModelCatalog,
  );
  const contextWindow = await resolveContextWindowForUpdate({
    modelHandle,
    updateArgs,
    options,
    useBackendModelCatalog,
    fetchCurrent: async () => {
      const conversation = await backend.retrieveConversation(conversationId);
      const conversationContextWindow =
        contextWindowFromEntityRecord(conversation);
      if (conversationContextWindow !== undefined) {
        return conversationContextWindow;
      }
      const agentId = isRecord(conversation)
        ? conversation.agent_id
        : undefined;
      if (typeof agentId !== "string" || agentId.length === 0) {
        return undefined;
      }
      return contextWindowFromEntityRecord(
        await backend.retrieveAgent(agentId),
      );
    },
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

  options?.signal?.throwIfAborted();
  return backend.updateConversation(
    conversationId,
    payload,
    ...(options?.signal ? [{ signal: options.signal }] : []),
  );
}

export interface ModelConfigUpdate {
  model?: string;
  reasoningEffort?: ModelReasoningSelection;
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
          useBackendModelCatalog,
        )
      : undefined;
  const hasModelSettings =
    modelSettings !== undefined && Object.keys(modelSettings).length > 0;

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

export async function updateAgentSystemPromptRaw(
  agentId: string,
  systemPromptContent: string | null,
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

export interface UpdateSystemPromptResult {
  success: boolean;
  message: string;
  agent: AgentState | null;
}

export async function updateAgentSystemPrompt(
  agentId: string,
  systemPromptId: string,
): Promise<UpdateSystemPromptResult> {
  try {
    const { isKnownPreset } = await import("@/agent/prompt-assets");
    const { resolveAndBuildSystemPrompt } = await import(
      "@/agent/system-prompt-resolution"
    );
    const { getMemoryPromptModeForAgent, recordManagedSystemPrompt } =
      await import("@/agent/system-prompt-versioning");
    const { settingsManager } = await import("@/settings-manager");

    const backend = getBackend();
    const memoryMode = getMemoryPromptModeForAgent(agentId);

    const systemPromptContent = await resolveAndBuildSystemPrompt(
      systemPromptId,
      memoryMode,
    );

    const { isLettaCloud } = await import("@/agent/memory-filesystem");
    const useCloudDefault =
      systemPromptId === "default" &&
      backend.capabilities.remoteMemfs &&
      !backend.capabilities.localMemfs &&
      (await isLettaCloud());
    debugLog("modify", "systemPromptContent: %s", systemPromptContent);

    const updateResult = await updateAgentSystemPromptRaw(
      agentId,
      useCloudDefault ? null : systemPromptContent,
    );
    if (!updateResult.success) {
      return {
        success: false,
        message: updateResult.message,
        agent: null,
      };
    }

    if (settingsManager.isReady) {
      if (useCloudDefault) {
        settingsManager.clearSystemPromptPreset(agentId);
      } else if (isKnownPreset(systemPromptId)) {
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

    const agent = await backend.retrieveAgent(agentId, {
      include: ["agent.tools", "agent.tags"],
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

export async function updateAgentSystemPromptMemfs(
  agentId: string,
): Promise<SystemPromptUpdateResult> {
  try {
    const { settingsManager } = await import("@/settings-manager");
    const {
      isKnownPreset,
      buildSystemPrompt,
      getSystemPromptVariantContents,
      SYSTEM_PROMPTS,
    } = await import("@/agent/prompt-assets");
    const {
      getMemoryPromptModeForAgent,
      hashSystemPrompt,
      recordManagedSystemPrompt,
    } = await import("@/agent/system-prompt-versioning");

    const backend = getBackend();
    const newMode = getMemoryPromptModeForAgent(agentId);
    const storedPreset = settingsManager.isReady
      ? settingsManager.getSystemPromptPreset(agentId)
      : undefined;
    const storedHash = settingsManager.isReady
      ? settingsManager.getSystemPromptHash(agentId)
      : undefined;

    const agent = await backend.retrieveAgent(agentId);
    if (agent.system == null) {
      return {
        success: true,
        message: "Backend default system prompt follows memory mode",
      };
    }
    const { reconcileCloudPromptForMemoryMode } = await import(
      "@/agent/cloud-managed-system-prompt"
    );
    const cloudPromptResult = await reconcileCloudPromptForMemoryMode({
      agent,
      memoryMode: newMode,
      storedPreset,
      storedHash,
    });
    if (cloudPromptResult) {
      return {
        success: true,
        message: cloudPromptResult,
      };
    }

    let nextSystemPrompt: string;
    if (storedPreset && isKnownPreset(storedPreset)) {
      const currentSystemPrompt = agent.system;
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
        const preset = SYSTEM_PROMPTS.find(
          (candidate) => candidate.id === storedPreset,
        );
        const matchesBundledVariant =
          preset &&
          getSystemPromptVariantContents(preset).some(
            (content) => content.trim() === currentSystemPrompt.trim(),
          );
        if (!matchesBundledVariant) {
          settingsManager.setSystemPromptCustom(agentId);
          return {
            success: true,
            message: "Custom system prompt left unchanged for memory mode",
          };
        }
      }

      nextSystemPrompt = buildSystemPrompt(storedPreset, newMode);
    } else {
      nextSystemPrompt = agent.system;
    }

    await backend.updateAgent(agentId, {
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
