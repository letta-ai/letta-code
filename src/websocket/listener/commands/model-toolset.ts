import type WebSocket from "ws";
import {
  getAvailableModelHandles,
  getCachedAvailableModels,
} from "@/agent/available-models";
import {
  getModelInfo,
  models,
  shouldPreserveContextWindowForModelSelection,
} from "@/agent/model";
import {
  updateAgentLLMConfig,
  updateConversationLLMConfig,
} from "@/agent/modify";
import { getBackend } from "@/backend";
import {
  buildByokProviderAliases,
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
  UpdateModelResponseMessage,
  UpdateToolsetResponseMessage,
} from "@/types/protocol_v2";
import { ensureListenerModAdapter } from "@/websocket/listener/mod-adapter";
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
  buildListModelsEntries,
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
  agentId: string;
  conversationId: string;
}): Promise<ModelScopeSnapshot> {
  const backend = getBackend();
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
  agentId: string;
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

export function resolveModelForUpdate(payload: {
  model_id?: string;
  model_handle?: string;
}): ResolvedModelForUpdate | null {
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
      const updateArgs =
        byId.updateArgs && typeof byId.updateArgs === "object"
          ? ({ ...byId.updateArgs } as Record<string, unknown>)
          : undefined;
      const providerType = inferProviderTypeFromRegistryHandle(byId.handle);
      const availableModel = findAvailableModelForPreset(
        byId.handle,
        availableModels,
      );
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
      return {
        id: payload.model_id,
        handle: explicitHandle ?? payload.model_id,
        label: nativeModel?.label ?? payload.model_id,
        updateArgs: undefined,
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
    return {
      id: payload.model_handle,
      handle: payload.model_handle,
      label: nativeModel?.label ?? payload.model_handle,
      updateArgs: undefined,
    };
  }

  return null;
}

function formatToolsetStatusMessageForModelUpdate(params: {
  nextToolset: ToolsetName;
  toolsetPreference: ToolsetName | "auto";
}): string {
  const { nextToolset, toolsetPreference } = params;

  if (toolsetPreference === "auto") {
    return (
      "Toolset auto-switched for this model: now using the " +
      formatToolsetName(nextToolset) +
      " toolset."
    );
  }

  return (
    "Manual toolset override remains active: " +
    formatToolsetName(toolsetPreference) +
    "."
  );
}

function formatEffortSuffix(
  modelLabel: string,
  updateArgs?: Record<string, unknown>,
): string {
  if (!updateArgs) return "";
  const effort = updateArgs.reasoning_effort;
  if (typeof effort !== "string" || effort.length === 0) return "";
  const xhighLabel =
    modelLabel.includes("Fable 5") ||
    modelLabel.includes("Opus 4.7") ||
    modelLabel.includes("Opus 4.8")
      ? "Extra-High"
      : "Max";
  const labels: Record<string, string> = {
    none: "No Reasoning",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: xhighLabel,
    max: "Max",
  };
  return ` (${labels[effort] ?? effort})`;
}

export function buildModelUpdateStatusMessage(params: {
  modelLabel: string;
  toolsetChanged: boolean;
  toolsetError: string | null;
  nextToolset: ToolsetName;
  toolsetPreference: ToolsetName | "auto";
  updateArgs?: Record<string, unknown>;
}): { message: string; level: "info" | "warning" } {
  const {
    modelLabel,
    toolsetChanged,
    toolsetError,
    nextToolset,
    toolsetPreference,
    updateArgs,
  } = params;
  let message = `Model updated to ${modelLabel}${formatEffortSuffix(modelLabel, updateArgs)}.`;
  if (toolsetError) {
    message += ` Warning: toolset switch failed (${toolsetError}).`;
    return { message, level: "warning" };
  }
  if (toolsetChanged) {
    message += ` ${formatToolsetStatusMessageForModelUpdate({
      nextToolset,
      toolsetPreference,
    })}`;
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

  if (!agentId) {
    return {
      type: "update_model_response",
      request_id: requestId,
      success: false,
      error: "Missing agent_id in runtime scope",
    };
  }

  const isDefaultConversation = conversationId === "default";

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
  const shouldPreserveContextWindow =
    shouldPreserveContextWindowForModelSelection({
      currentModelHandle: currentModelScope.modelHandle,
      currentLlmConfig: currentModelScope.llmConfig,
      selectedModelHandle: model.handle,
      selectedContextWindow,
    });
  const updateArgsForRequest = { ...updateArgs };
  if (shouldPreserveContextWindow) {
    delete updateArgsForRequest.context_window;
  }

  let modelSettings: Record<string, unknown> | null = null;
  let appliedTo: "agent" | "conversation";

  if (isDefaultConversation) {
    const updatedAgent = await updateAgentLLMConfig(
      agentId,
      model.handle,
      updateArgsForRequest,
      { avoidOverwritingExistingContextWindow: shouldPreserveContextWindow },
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
      { avoidOverwritingExistingContextWindow: shouldPreserveContextWindow },
    );
    modelSettings =
      ((
        updatedConversation as {
          model_settings?: Record<string, unknown> | null;
        }
      ).model_settings as Record<string, unknown> | null | undefined) ?? null;
    appliedTo = "conversation";
  }

  const toolsetPreference = settingsManager.getToolsetPreference(agentId);
  const previousToolNames = scopedRuntime.currentLoadedTools;
  let nextToolset: ToolsetName;
  let nextLoadedTools: string[] = previousToolNames;
  let toolsetError: string | null = null;

  try {
    await ensureCorrectMemoryTool(agentId, model.handle);
    const preparedToolContext = await prepareToolExecutionContextForScope({
      agentId,
      conversationId,
      overrideModel: model.handle,
      overrideProviderType:
        providerTypeFromModelSettings(modelSettings) ??
        inferProviderTypeFromRegistryHandle(model.handle) ??
        null,
      modEvents: ensureListenerModAdapter(listener).events,
    });
    nextToolset = preparedToolContext.toolset;
    nextLoadedTools = preparedToolContext.preparedToolContext.loadedToolNames;
    scopedRuntime.currentToolset = preparedToolContext.toolset;
    scopedRuntime.currentToolsetPreference =
      preparedToolContext.toolsetPreference;
    scopedRuntime.currentLoadedTools = nextLoadedTools;
  } catch (error) {
    nextToolset = toolsetPreference === "auto" ? "default" : toolsetPreference;
    toolsetError =
      error instanceof Error ? error.message : "Failed to switch toolset";
  }

  const toolsetChanged =
    !toolsetError &&
    JSON.stringify(previousToolNames) !== JSON.stringify(nextLoadedTools);
  const { message: statusMessage, level: statusLevel } =
    buildModelUpdateStatusMessage({
      modelLabel: model.label,
      toolsetChanged,
      toolsetError,
      nextToolset,
      toolsetPreference,
      updateArgs: model.updateArgs,
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

  if (!agentId) {
    return {
      type: "update_toolset_response",
      request_id: requestId,
      success: false,
      error: "Missing agent_id in runtime scope",
    };
  }

  const previousToolNames = scopedRuntime.currentLoadedTools;
  let nextToolset: ToolsetName;
  const previousToolsetPreference = (() => {
    try {
      return settingsManager.getToolsetPreference(agentId);
    } catch {
      return scopedRuntime.currentToolsetPreference;
    }
  })();

  try {
    settingsManager.setToolsetPreference(agentId, toolsetPreference);
    const preparedToolContext = await prepareToolExecutionContextForScope({
      agentId,
      conversationId,
      modEvents: ensureListenerModAdapter(listener).events,
    });
    nextToolset = preparedToolContext.toolset;
    scopedRuntime.currentToolset = preparedToolContext.toolset;
    scopedRuntime.currentToolsetPreference =
      preparedToolContext.toolsetPreference;
    scopedRuntime.currentLoadedTools =
      preparedToolContext.preparedToolContext.loadedToolNames;
  } catch (error) {
    settingsManager.setToolsetPreference(agentId, previousToolsetPreference);
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
  const [handlesResult, providersResult] = await Promise.allSettled([
    // User-initiated refreshes bypass the availability cache: within the
    // cache TTL a stale snapshot would otherwise make every "Refresh model
    // list" click return the same wrong answer.
    getAvailableModelHandles(
      options.forceRefresh === true ? { forceRefresh: true } : undefined,
    ),
    listProviders(),
  ]);

  const availableHandles: string[] | null =
    handlesResult.status === "fulfilled"
      ? [...handlesResult.value.handles]
      : null;
  const entries = buildListModelsEntries(
    handlesResult.status === "fulfilled" ? handlesResult.value.models : [],
  );

  // listProviders already degrades to [] on failure, but handle rejection too
  const providers =
    providersResult.status === "fulfilled" ? providersResult.value : [];
  const byokProviderAliases = buildByokProviderAliases(providers);

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

      const resolvedModel = resolveModelForUpdate(parsed.payload);
      if (!resolvedModel) {
        const failure: UpdateModelResponseMessage = {
          type: "update_model_response",
          request_id: parsed.request_id,
          success: false,
          error:
            "Model not found. Provide a valid model_id from list_models or a model_handle.",
        };
        safeSocketSend(
          socket,
          failure,
          "listener_update_model_send_failed",
          "listener_update_model",
        );
        return;
      }

      try {
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
          model_id: resolvedModel.id,
          model_handle: resolvedModel.handle,
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
