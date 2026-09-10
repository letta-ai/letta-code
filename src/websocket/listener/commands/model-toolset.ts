import type WebSocket from "ws";
import {
  getAvailableModelHandles,
  getCachedAvailableModels,
} from "@/agent/available-models";
import {
  getModelInfo,
  models,
  preservableContextWindow,
  shouldPreserveContextWindowForModelSelection,
} from "@/agent/model";
import {
  updateAgentLLMConfig,
  updateConversationLLMConfig,
} from "@/agent/modify";
import {
  catalogHasDistinctMaxTier,
  formatXhighEffortLabel,
} from "@/agent/reasoning-effort-label";
import { refreshModelCatalog } from "@/agent/remote-model-catalog";
import { getBackend } from "@/backend";
import { isCloudServerUrl } from "@/backend/api/server-url";
import { resolveBackendMode } from "@/backend/backend-mode";
import {
  buildByokProviderAliases,
  buildOpenAICompatibleProxyProviderNames,
  listProviders,
} from "@/providers/byok-providers";
import { settingsManager } from "@/settings-manager";
import {
  ensureCorrectMemoryTool,
  prepareToolExecutionContextForScope,
  type ToolsetName,
  type ToolsetPreference,
} from "@/tools/toolset";
import { formatToolsetName } from "@/tools/toolset-labels";
import type {
  ListModelsResponseMessage,
  UpdateModelPayload,
  UpdateModelResponseMessage,
  UpdateToolsetResponseMessage,
} from "@/types/protocol_v2";
import { OPENAI_COMPATIBLE_PROXY_UPDATE_ARG } from "@/utils/openai-endpoint";
import {
  createListenerAgentModContext,
  createListenerModEvents,
  ensureListenerModAdaptersForAgent,
} from "@/websocket/listener/mod-adapter";
import {
  isListModelsCommand,
  isUpdateModelCommand,
  isUpdateToolsetCommand,
} from "@/websocket/listener/protocol-inbound";
import {
  emitRuntimeStateUpdates,
  emitStatusDelta,
} from "@/websocket/listener/protocol-outbound";
import type { ListenerTransport } from "@/websocket/listener/transport";
import type {
  ConversationRuntime,
  ListenerRuntime,
} from "@/websocket/listener/types";
import {
  availableModelUpdateArgs,
  buildListModelsEntries,
  buildNativeModelEntry,
  findAvailableModelForPreset,
} from "./model-catalog";
import type {
  GetOrCreateScopedRuntime,
  RunDetachedListenerTask,
  SafeSocketSend,
} from "./types";

export type ResolvedModelForUpdate = {
  id: string;
  handle: string;
  label: string;
  updateArgs?: Record<string, unknown>;
};

type ModelToolsetCommandContext = {
  socket: WebSocket;
  runtime: ListenerRuntime;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
  getOrCreateScopedRuntime: GetOrCreateScopedRuntime;
};

type ModelScopeSnapshot = {
  modelHandle: string | null;
  llmConfig: {
    model?: string | null;
    model_endpoint_type?: string | null;
    context_window?: number | null;
  } | null;
};

export type CurrentModelStatus = {
  modelHandle: string | null;
  modelLabel: string;
  scope: "agent" | "conversation";
};

function inferProviderTypeFromRegistryHandle(
  modelHandle: string,
): string | undefined {
  const provider = modelHandle.split("/")[0];
  if (!provider) return undefined;
  if (provider === "openai-codex" || provider === "chatgpt-plus-pro") {
    return "chatgpt_oauth";
  }
  if (
    provider === "anthropic" ||
    provider === "bedrock" ||
    provider === "google_ai" ||
    provider === "google_vertex" ||
    provider === "minimax" ||
    provider === "openai" ||
    provider === "openrouter" ||
    provider === "zai"
  ) {
    return provider;
  }
  return undefined;
}

function buildModelHandleFromConfig(
  config: ModelScopeSnapshot["llmConfig"],
): string | null {
  if (!config) return null;
  if (config.model_endpoint_type && config.model) {
    return `${config.model_endpoint_type}/${config.model}`;
  }
  return config.model ?? null;
}

function providerTypeFromModelSettings(
  modelSettings: Record<string, unknown> | null,
): string | null {
  const providerType = modelSettings?.provider_type;
  return typeof providerType === "string" ? providerType : null;
}

function withContextWindow(
  baseConfig: ModelScopeSnapshot["llmConfig"],
  contextWindow?: number,
): ModelScopeSnapshot["llmConfig"] {
  return {
    ...(baseConfig ?? {}),
    ...(typeof contextWindow === "number"
      ? { context_window: contextWindow }
      : {}),
  };
}

async function getCurrentModelScopeSnapshot(params: {
  agentId: string | null;
  conversationId: string;
}): Promise<ModelScopeSnapshot> {
  const backend = getBackend();
  if (!params.agentId) {
    const conversation = await backend.retrieveConversation(
      params.conversationId,
    );
    const record = conversation as unknown as Record<string, unknown>;
    return {
      modelHandle: typeof record.model === "string" ? record.model : null,
      llmConfig: withContextWindow(
        (record.model_settings as ModelScopeSnapshot["llmConfig"]) ?? null,
        typeof record.context_window_limit === "number"
          ? record.context_window_limit
          : undefined,
      ),
    };
  }

  const agent = await backend.retrieveAgent(params.agentId);
  const agentRecord = agent as unknown as Record<string, unknown>;
  const agentModelHandle =
    typeof agent.model === "string" && agent.model.length > 0
      ? agent.model
      : buildModelHandleFromConfig(
          agent.llm_config as ModelScopeSnapshot["llmConfig"],
        );
  const agentContextWindow =
    typeof agentRecord.context_window_limit === "number"
      ? agentRecord.context_window_limit
      : typeof agent.llm_config?.context_window === "number"
        ? agent.llm_config.context_window
        : undefined;

  if (params.conversationId === "default") {
    return {
      modelHandle: agentModelHandle,
      llmConfig: withContextWindow(
        agent.llm_config as ModelScopeSnapshot["llmConfig"],
        agentContextWindow,
      ),
    };
  }

  const conversation = await backend.retrieveConversation(
    params.conversationId,
  );
  const conversationRecord = conversation as unknown as Record<string, unknown>;
  const conversationModel =
    typeof conversationRecord.model === "string"
      ? conversationRecord.model
      : null;
  const conversationContextWindow =
    typeof conversationRecord.context_window_limit === "number"
      ? conversationRecord.context_window_limit
      : undefined;

  return {
    modelHandle: conversationModel ?? agentModelHandle,
    llmConfig: withContextWindow(
      agent.llm_config as ModelScopeSnapshot["llmConfig"],
      conversationContextWindow ?? agentContextWindow,
    ),
  };
}

export async function getCurrentModelStatusForRuntime(params: {
  agentId: string | null;
  conversationId: string;
}): Promise<CurrentModelStatus> {
  const snapshot = await getCurrentModelScopeSnapshot(params);
  const modelInfo = snapshot.modelHandle
    ? getModelInfo(snapshot.modelHandle)
    : null;
  return {
    modelHandle: snapshot.modelHandle,
    modelLabel: modelInfo?.label ?? snapshot.modelHandle ?? "unknown",
    scope: params.conversationId === "default" ? "agent" : "conversation",
  };
}

function resolveModelForUpdateBase(
  payload: UpdateModelPayload,
): ResolvedModelForUpdate | null {
  const availableModels = getCachedAvailableModels() ?? [];
  if (typeof payload.model_id === "string" && payload.model_id.length > 0) {
    const byId = getModelInfo(payload.model_id);
    if (byId) {
      // When an explicit model_handle is also provided (e.g. BYOK tier
      // changes), use the model_id entry for updateArgs/label but preserve
      // the caller-specified handle so the BYOK identity is maintained
      // end-to-end.
      const explicitHandle =
        typeof payload.model_handle === "string" &&
        payload.model_handle.length > 0
          ? payload.model_handle
          : null;
      const providerType = inferProviderTypeFromRegistryHandle(byId.handle);
      const availableModel = explicitHandle
        ? availableModels.find((model) => model.handle === explicitHandle)
        : resolveBackendMode() === "api" && isCloudServerUrl()
          ? undefined
          : findAvailableModelForPreset(byId.handle, availableModels);
      const availableUpdateArgs = availableModelUpdateArgs(availableModel);
      const updateArgs =
        byId.updateArgs || availableUpdateArgs
          ? {
              ...((byId.updateArgs as Record<string, unknown> | undefined) ??
                {}),
              ...(availableUpdateArgs ?? {}),
            }
          : undefined;
      if (
        (explicitHandle || availableModel) &&
        updateArgs &&
        (availableModel?.providerType || providerType) &&
        typeof updateArgs.provider_type !== "string"
      ) {
        updateArgs.provider_type = availableModel?.providerType ?? providerType;
      }

      return {
        id: byId.id,
        handle: explicitHandle ?? availableModel?.handle ?? byId.handle,
        label: byId.label,
        updateArgs,
      };
    }

    const nativeModel = availableModels.find(
      (model) => model.handle === payload.model_id,
    );
    if (nativeModel || payload.model_id.includes("/")) {
      const explicitHandle =
        typeof payload.model_handle === "string" &&
        payload.model_handle.length > 0
          ? payload.model_handle
          : null;
      const entry = nativeModel ? buildNativeModelEntry(nativeModel) : null;
      return {
        id: payload.model_id,
        handle: explicitHandle ?? payload.model_id,
        label: entry?.label ?? payload.model_id,
        updateArgs: entry?.updateArgs,
      };
    }
  }

  if (
    typeof payload.model_handle === "string" &&
    payload.model_handle.length > 0
  ) {
    const exactByHandle = models.find((m) => m.handle === payload.model_handle);
    if (exactByHandle) {
      return {
        id: exactByHandle.id,
        handle: exactByHandle.handle,
        label: exactByHandle.label,
        updateArgs:
          exactByHandle.updateArgs &&
          typeof exactByHandle.updateArgs === "object"
            ? ({ ...exactByHandle.updateArgs } as Record<string, unknown>)
            : undefined,
      };
    }

    const nativeModel = availableModels.find(
      (model) => model.handle === payload.model_handle,
    );
    const entry = nativeModel ? buildNativeModelEntry(nativeModel) : null;
    return {
      id: payload.model_handle,
      handle: payload.model_handle,
      label: entry?.label ?? payload.model_handle,
      updateArgs: entry?.updateArgs,
    };
  }

  return null;
}

export async function resolveModelForUpdateWithInventory(
  payload: UpdateModelPayload,
): Promise<ResolvedModelForUpdate | null> {
  const handle = payload.model_handle ?? payload.model_id;
  // A first-contact /model <BYOK handle>, or a click after a listener restart,
  // has not necessarily listed models. Load its provider identity before
  // constructing settings; hosted catalog selections need no inventory probe.
  if (
    resolveBackendMode() === "api" &&
    isCloudServerUrl() &&
    handle?.includes("/") &&
    !models.some((model) => model.handle === handle) &&
    !getCachedAvailableModels()?.some((model) => model.handle === handle)
  ) {
    await getAvailableModelHandles();
  }
  return resolveModelForUpdate(payload);
}

export function resolveModelForUpdate(
  payload: UpdateModelPayload,
): ResolvedModelForUpdate | null {
  const resolved = resolveModelForUpdateBase(payload);
  const acceptsDeviceReasoningEffort =
    resolved?.updateArgs?.[OPENAI_COMPATIBLE_PROXY_UPDATE_ARG] === true ||
    resolved?.updateArgs?.provider_type === "chatgpt_oauth" ||
    (resolved !== null &&
      inferProviderTypeFromRegistryHandle(resolved.handle) === "chatgpt_oauth");
  if (
    !resolved ||
    payload.reasoning_effort === undefined ||
    !acceptsDeviceReasoningEffort
  ) {
    return resolved;
  }
  return {
    ...resolved,
    updateArgs: {
      ...resolved.updateArgs,
      reasoning_effort: payload.reasoning_effort,
    },
  };
}

function formatEffortSuffix(
  modelLabel: string,
  updateArgs?: Record<string, unknown>,
  modelHandle?: string,
): string {
  if (!updateArgs) return "";
  const effort = updateArgs.reasoning_effort;
  if (typeof effort !== "string" || effort.length === 0) return "";
  const labels: Record<string, string> = {
    none: "No Reasoning",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: formatXhighEffortLabel(
      catalogHasDistinctMaxTier({ modelLabel, modelHandle }),
    ),
    max: "Max",
  };
  return ` (${labels[effort] ?? effort})`;
}

export function buildModelUpdateStatusMessage(params: {
  modelLabel: string;
  toolsetError: string | null;
  updateArgs?: Record<string, unknown>;
  modelHandle?: string;
}): { message: string; level: "info" | "warning" } {
  const { modelLabel, toolsetError, updateArgs, modelHandle } = params;
  let message = `Model updated to ${modelLabel}${formatEffortSuffix(modelLabel, updateArgs, modelHandle)}.`;
  if (toolsetError) {
    message += ` Warning: toolset switch failed (${toolsetError}).`;
    return { message, level: "warning" };
  }
  return { message, level: "info" };
}

export async function applyModelUpdateForRuntime(params: {
  socket: ListenerTransport;
  listener: ListenerRuntime;
  scopedRuntime: ConversationRuntime;
  requestId: string;
  model: ResolvedModelForUpdate;
}): Promise<UpdateModelResponseMessage> {
  const { socket, listener, scopedRuntime, requestId, model } = params;
  const agentId = scopedRuntime.agentId;
  const conversationId = scopedRuntime.conversationId;

  const isDefaultConversation = conversationId === "default";
  if (isDefaultConversation && !agentId) {
    return {
      type: "update_model_response",
      request_id: requestId,
      success: false,
      error: "Agent-free runtimes require a persisted conversation",
    };
  }

  const updateArgs: Record<string, unknown> = {
    ...(model.updateArgs ?? {}),
    parallel_tool_calls: true,
  };
  const selectedContextWindow =
    typeof updateArgs.context_window === "number"
      ? updateArgs.context_window
      : undefined;
  const currentModelScope = await getCurrentModelScopeSnapshot({
    agentId,
    conversationId,
  });
  // Switching to a different model (or a different context-window variant of
  // the same model, e.g. base <-> 1M dual listings) resets the context window
  // to the selected catalog entry's preset. Only a tier change within the
  // same variant preserves the current window — and it preserves by
  // RE-SENDING the current value explicitly, never by omitting the field:
  // the server treats an omitted context_window_limit as "re-derive from the
  // handle" and clamps it to a legacy global default (128k). A current value
  // that looks like that clamp is not preservable, so poisoned agents heal
  // to the preset even on same-variant tier changes. See LET-9786.
  const shouldPreserveContextWindow =
    shouldPreserveContextWindowForModelSelection({
      currentModelHandle: currentModelScope.modelHandle,
      currentLlmConfig: currentModelScope.llmConfig,
      selectedModelHandle: model.handle,
      selectedContextWindow,
    });
  const preservedContextWindow = shouldPreserveContextWindow
    ? preservableContextWindow(
        currentModelScope.llmConfig?.context_window,
        model.handle,
      )
    : undefined;
  const updateOptions =
    preservedContextWindow !== undefined
      ? { contextWindowOverride: preservedContextWindow }
      : undefined;
  const updateArgsForRequest = { ...updateArgs };

  let modelSettings: Record<string, unknown> | null = null;
  let appliedTo: "agent" | "conversation";

  if (isDefaultConversation && agentId) {
    const updatedAgent = await updateAgentLLMConfig(
      agentId,
      model.handle,
      updateArgsForRequest,
      updateOptions,
    );
    modelSettings =
      (updatedAgent.model_settings as
        | Record<string, unknown>
        | null
        | undefined) ?? null;
    appliedTo = "agent";
  } else {
    const updatedConversation = await updateConversationLLMConfig(
      conversationId,
      model.handle,
      updateArgsForRequest,
      updateOptions,
    );
    modelSettings =
      ((
        updatedConversation as {
          model_settings?: Record<string, unknown> | null;
        }
      ).model_settings as Record<string, unknown> | null | undefined) ?? null;
    appliedTo = "conversation";
  }

  let toolsetError: string | null = null;

  try {
    if (agentId) {
      await ensureCorrectMemoryTool(agentId, model.handle);
    }
    const modAdapters = agentId
      ? await ensureListenerModAdaptersForAgent(listener, agentId)
      : [];
    const preparedToolContext = await prepareToolExecutionContextForScope({
      agentId,
      conversationId,
      overrideModel: model.handle,
      overrideProviderType:
        providerTypeFromModelSettings(modelSettings) ??
        inferProviderTypeFromRegistryHandle(model.handle) ??
        null,
      ...(agentId
        ? { modContext: createListenerAgentModContext(agentId) }
        : {}),
      modAdapters,
      modEvents: createListenerModEvents(modAdapters),
    });
    scopedRuntime.currentToolset = preparedToolContext.toolset;
    scopedRuntime.currentToolsetPreference =
      preparedToolContext.toolsetPreference;
    scopedRuntime.currentLoadedTools =
      preparedToolContext.preparedToolContext.loadedToolNames;
  } catch (error) {
    toolsetError =
      error instanceof Error ? error.message : "Failed to switch toolset";
  }

  const { message: statusMessage, level: statusLevel } =
    buildModelUpdateStatusMessage({
      modelLabel: model.label,
      toolsetError,
      updateArgs: model.updateArgs,
      modelHandle: model.handle,
    });

  emitStatusDelta(socket, scopedRuntime, {
    message: statusMessage,
    level: statusLevel,
    agentId,
    conversationId,
  });

  emitRuntimeStateUpdates(listener, {
    agent_id: agentId,
    conversation_id: conversationId,
  });

  return {
    type: "update_model_response",
    request_id: requestId,
    success: true,
    runtime: {
      agent_id: agentId,
      conversation_id: conversationId,
    },
    applied_to: appliedTo,
    model_id: model.id,
    model_handle: model.handle,
    model_settings: modelSettings,
  };
}

export async function applyToolsetUpdateForRuntime(params: {
  socket: WebSocket;
  listener: ListenerRuntime;
  scopedRuntime: ConversationRuntime;
  requestId: string;
  toolsetPreference: ToolsetPreference;
}): Promise<UpdateToolsetResponseMessage> {
  const { socket, listener, scopedRuntime, requestId, toolsetPreference } =
    params;
  const agentId = scopedRuntime.agentId;
  const conversationId = scopedRuntime.conversationId;

  const settingsScopeId = agentId ?? conversationId;
  const previousToolNames = scopedRuntime.currentLoadedTools;
  let nextToolset: ToolsetName;
  const previousToolsetPreference = (() => {
    try {
      return settingsManager.getToolsetPreference(
        settingsScopeId,
        conversationId,
      );
    } catch {
      return scopedRuntime.currentToolsetPreference;
    }
  })();

  try {
    settingsManager.setToolsetPreference(
      settingsScopeId,
      toolsetPreference,
      conversationId,
    );
    const modAdapters = agentId
      ? await ensureListenerModAdaptersForAgent(listener, agentId)
      : [];
    const preparedToolContext = await prepareToolExecutionContextForScope({
      agentId,
      conversationId,
      ...(agentId
        ? { modContext: createListenerAgentModContext(agentId) }
        : {}),
      modAdapters,
      modEvents: createListenerModEvents(modAdapters),
    });
    nextToolset = preparedToolContext.toolset;
    scopedRuntime.currentToolset = preparedToolContext.toolset;
    scopedRuntime.currentToolsetPreference =
      preparedToolContext.toolsetPreference;
    scopedRuntime.currentLoadedTools =
      preparedToolContext.preparedToolContext.loadedToolNames;
  } catch (error) {
    settingsManager.setToolsetPreference(
      settingsScopeId,
      previousToolsetPreference,
      conversationId,
    );
    throw error;
  }

  const toolsChanged =
    JSON.stringify(previousToolNames) !==
    JSON.stringify(scopedRuntime.currentLoadedTools);

  const statusMessage =
    toolsetPreference === "auto"
      ? `Toolset mode set to auto (currently ${formatToolsetName(nextToolset)}).`
      : `Switched toolset to ${formatToolsetName(nextToolset)} (manual override).`;

  emitStatusDelta(socket, scopedRuntime, {
    message: statusMessage,
    level: toolsChanged ? "info" : "info",
    agentId,
    conversationId,
  });

  emitRuntimeStateUpdates(listener, {
    agent_id: agentId,
    conversation_id: conversationId,
  });

  return {
    type: "update_toolset_response",
    request_id: requestId,
    success: true,
    runtime: {
      agent_id: agentId,
      conversation_id: conversationId,
    },
    current_toolset: nextToolset,
    current_toolset_preference: toolsetPreference,
  };
}

/**
 * Build the full list_models_response payload, including availability data.
 * Fetches available handles and BYOK provider aliases in parallel (best-effort).
 */
export async function buildListModelsResponse(
  requestId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<ListModelsResponseMessage> {
  const cloud = resolveBackendMode() === "api" && isCloudServerUrl();
  const [handlesResult, providersResult] = await Promise.allSettled([
    // User-initiated refreshes bypass the availability cache: within the
    // cache TTL a stale snapshot would otherwise make every "Refresh model
    // list" click return the same wrong answer.
    getAvailableModelHandles(
      options.forceRefresh === true ? { forceRefresh: true } : undefined,
    ),
    listProviders(),
    // Refresh the runtime catalog alongside availability. API mode keeps the
    // persisted cloud catalog on temporary failures; local mode projects pi-ai.
    refreshModelCatalog(
      options.forceRefresh === true ? { force: true } : undefined,
    ),
  ]);

  // listProviders already degrades to [] on failure, but handle rejection too
  const providers =
    providersResult.status === "fulfilled" ? providersResult.value : [];
  const byokProviderAliases = buildByokProviderAliases(providers);
  const openAICompatibleProxyProviders =
    buildOpenAICompatibleProxyProviderNames(providers);
  const entries = buildListModelsEntries(
    handlesResult.status === "fulfilled" ? handlesResult.value.models : [],
    { cloud },
  ).map((entry) => {
    const providerName = entry.handle.split("/")[0];
    if (
      providerName === undefined ||
      !openAICompatibleProxyProviders.has(providerName)
    ) {
      return entry;
    }
    return {
      ...entry,
      updateArgs: {
        ...(entry.updateArgs ?? {}),
        provider_type: "openai",
        [OPENAI_COMPATIBLE_PROXY_UPDATE_ARG]: true,
      },
    };
  });

  // Channel clients use this list as selectable inventory, not just a hint.
  // In Cloud mode it must not reintroduce legacy hosted rows or gate presets.
  const availableHandles: string[] | null = cloud
    ? [...new Set(entries.map((entry) => entry.handle))]
    : handlesResult.status === "fulfilled"
      ? [...handlesResult.value.handles]
      : null;

  return {
    type: "list_models_response",
    request_id: requestId,
    success: true,
    entries,
    available_handles: availableHandles,
    byok_provider_aliases: byokProviderAliases,
  };
}

export function handleModelToolsetCommand(
  parsed: unknown,
  context: ModelToolsetCommandContext,
): boolean {
  const {
    socket,
    runtime,
    safeSocketSend,
    runDetachedListenerTask,
    getOrCreateScopedRuntime,
  } = context;

  if (isListModelsCommand(parsed)) {
    runDetachedListenerTask("list_models", async () => {
      try {
        const response = await buildListModelsResponse(parsed.request_id, {
          forceRefresh: parsed.force === true,
        });
        safeSocketSend(
          socket,
          response,
          "listener_list_models_send_failed",
          "listener_list_models",
        );
      } catch (error) {
        safeSocketSend(
          socket,
          {
            type: "list_models_response",
            request_id: parsed.request_id,
            success: false,
            entries: [],
            error:
              error instanceof Error ? error.message : "Failed to list models",
          },
          "listener_list_models_send_failed",
          "listener_list_models",
        );
      }
    });
    return true;
  }

  if (isUpdateModelCommand(parsed)) {
    runDetachedListenerTask("update_model", async () => {
      const scopedRuntime = getOrCreateScopedRuntime(
        runtime,
        parsed.runtime.agent_id,
        parsed.runtime.conversation_id,
      );

      let resolvedModel: ResolvedModelForUpdate | null = null;
      try {
        resolvedModel = await resolveModelForUpdateWithInventory(
          parsed.payload,
        );
        if (!resolvedModel) {
          throw new Error(
            "Model not found. Provide a valid model_id from list_models or a model_handle.",
          );
        }
        const response = await applyModelUpdateForRuntime({
          socket,
          listener: runtime,
          scopedRuntime,
          requestId: parsed.request_id,
          model: resolvedModel,
        });
        safeSocketSend(
          socket,
          response,
          "listener_update_model_send_failed",
          "listener_update_model",
        );
      } catch (error) {
        const failure: UpdateModelResponseMessage = {
          type: "update_model_response",

          request_id: parsed.request_id,
          success: false,
          runtime: {
            agent_id: parsed.runtime.agent_id,
            conversation_id: parsed.runtime.conversation_id,
          },
          model_id: resolvedModel?.id ?? parsed.payload.model_id,
          model_handle: resolvedModel?.handle ?? parsed.payload.model_handle,
          error:
            error instanceof Error ? error.message : "Failed to update model",
        };
        safeSocketSend(
          socket,
          failure,
          "listener_update_model_send_failed",
          "listener_update_model",
        );
      }
    });
    return true;
  }

  if (isUpdateToolsetCommand(parsed)) {
    runDetachedListenerTask("update_toolset", async () => {
      const scopedRuntime = getOrCreateScopedRuntime(
        runtime,
        parsed.runtime.agent_id,
        parsed.runtime.conversation_id,
      );

      try {
        const response = await applyToolsetUpdateForRuntime({
          socket,
          listener: runtime,
          scopedRuntime,
          requestId: parsed.request_id,
          toolsetPreference: parsed.toolset_preference,
        });
        safeSocketSend(
          socket,
          response,
          "listener_update_toolset_send_failed",
          "listener_update_toolset",
        );
      } catch (error) {
        const failure: UpdateToolsetResponseMessage = {
          type: "update_toolset_response",
          request_id: parsed.request_id,
          success: false,
          runtime: {
            agent_id: parsed.runtime.agent_id,
            conversation_id: parsed.runtime.conversation_id,
          },
          error:
            error instanceof Error ? error.message : "Failed to update toolset",
        };
        safeSocketSend(
          socket,
          failure,
          "listener_update_toolset_send_failed",
          "listener_update_toolset",
        );
      }
    });
    return true;
  }

  return false;
}
