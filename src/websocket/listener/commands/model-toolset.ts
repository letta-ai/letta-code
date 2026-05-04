import type WebSocket from "ws";
import { getAvailableModelHandles } from "../../../agent/available-models";
import { getModelInfo, models } from "../../../agent/model";
import {
  updateAgentLLMConfig,
  updateConversationLLMConfig,
} from "../../../agent/modify";
import {
  buildByokProviderAliases,
  listProviders,
} from "../../../providers/byok-providers";
import { settingsManager } from "../../../settings-manager";
import {
  ensureCorrectMemoryTool,
  prepareToolExecutionContextForScope,
  type ToolsetName,
  type ToolsetPreference,
} from "../../../tools/toolset";
import { formatToolsetName } from "../../../tools/toolset-labels";
import type {
  ListModelsResponseMessage,
  ListModelsResponseModelEntry,
  UpdateModelResponseMessage,
  UpdateToolsetResponseMessage,
} from "../../../types/protocol_v2";
import {
  isListModelsCommand,
  isUpdateModelCommand,
  isUpdateToolsetCommand,
} from "../protocol-inbound";
import { emitRuntimeStateUpdates, emitStatusDelta } from "../protocol-outbound";
import type { ConversationRuntime, ListenerRuntime } from "../types";
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

export function resolveModelForUpdate(payload: {
  model_id?: string;
  model_handle?: string;
}): ResolvedModelForUpdate | null {
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

      return {
        id: byId.id,
        handle: explicitHandle ?? byId.handle,
        label: byId.label,
        updateArgs:
          byId.updateArgs && typeof byId.updateArgs === "object"
            ? ({ ...byId.updateArgs } as Record<string, unknown>)
            : undefined,
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

    return {
      id: payload.model_handle,
      handle: payload.model_handle,
      label: payload.model_handle,
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
  const xhighLabel = modelLabel.includes("Opus 4.7") ? "Extra-High" : "Max";
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
  socket: WebSocket;
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

  const updateArgs = {
    ...(model.updateArgs ?? {}),
    parallel_tool_calls: true,
  };

  let modelSettings: Record<string, unknown> | null = null;
  let appliedTo: "agent" | "conversation";

  if (isDefaultConversation) {
    const updatedAgent = await updateAgentLLMConfig(
      agentId,
      model.handle,
      updateArgs,
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
      updateArgs,
      { preserveContextWindow: false },
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

export function buildListModelsEntries(): ListModelsResponseModelEntry[] {
  return models.map((model) => ({
    id: model.id,
    handle: model.handle,
    label: model.label,
    description: model.description,
    ...(typeof model.isDefault === "boolean"
      ? { isDefault: model.isDefault }
      : {}),
    ...(typeof model.isFeatured === "boolean"
      ? { isFeatured: model.isFeatured }
      : {}),
    ...(typeof model.free === "boolean" ? { free: model.free } : {}),
    ...(model.updateArgs && typeof model.updateArgs === "object"
      ? { updateArgs: model.updateArgs as Record<string, unknown> }
      : {}),
  }));
}

/**
 * Build the full list_models_response payload, including availability data.
 * Fetches available handles and BYOK provider aliases in parallel (best-effort).
 */
export async function buildListModelsResponse(
  requestId: string,
): Promise<ListModelsResponseMessage> {
  const entries = buildListModelsEntries();

  const [handlesResult, providersResult] = await Promise.allSettled([
    getAvailableModelHandles(),
    listProviders(),
  ]);

  const availableHandles: string[] | null =
    handlesResult.status === "fulfilled"
      ? [...handlesResult.value.handles]
      : null;

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
        const response = await buildListModelsResponse(parsed.request_id);
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
