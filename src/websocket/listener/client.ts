/**
 * WebSocket client for listen mode
 * Connects to Letta Cloud and receives messages to execute locally
 */

import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import WebSocket from "ws";
import { getAvailableModelHandles } from "../../agent/available-models";
import { getClient } from "../../agent/client";
import { getModelInfo, models, resolveModel } from "../../agent/model";
import {
  updateAgentLLMConfig,
  updateConversationLLMConfig,
} from "../../agent/modify";
import { getChannelRegistry } from "../../channels/registry";
import { resetContextHistory } from "../../cli/helpers/contextTracker";
import {
  ensureFileIndex,
  getIndexRoot,
  searchFileIndex,
  setIndexRoot,
} from "../../cli/helpers/fileIndex";
import { getGitContext } from "../../cli/helpers/gitContext";
import {
  getReflectionSettings,
  persistReflectionSettingsForAgent,
} from "../../cli/helpers/memoryReminder";
import { setMessageQueueAdder } from "../../cli/helpers/messageQueueBridge";
import { generatePlanFilePath } from "../../cli/helpers/planName";
import {
  getSubagents,
  subscribe as subscribeToSubagentState,
  subscribeToStreamEvents as subscribeToSubagentStreamEvents,
} from "../../cli/helpers/subagentState";
import { INTERRUPTED_BY_USER } from "../../constants";
import {
  addTask as addCronTask,
  deleteAllTasks as deleteAllCronTasks,
  deleteTask as deleteCronTask,
  getTask as getCronTask,
  listTasks as listCronTasks,
} from "../../cron";
import {
  startScheduler as startCronScheduler,
  stopScheduler as stopCronScheduler,
} from "../../cron/scheduler";
import {
  buildByokProviderAliases,
  listProviders,
} from "../../providers/byok-providers";
import { type DequeuedBatch, QueueRuntime } from "../../queue/queueRuntime";
import {
  createSharedReminderState,
  resetSharedReminderState,
} from "../../reminders/state";
import { settingsManager } from "../../settings-manager";
import { telemetry } from "../../telemetry";
import { trackBoundaryError } from "../../telemetry/errorReporting";
import { loadTools } from "../../tools/manager";
import {
  ensureCorrectMemoryTool,
  prepareToolExecutionContextForResolvedTarget,
  type ToolsetName,
} from "../../tools/toolset";
import { formatToolsetName } from "../../tools/toolset-labels";
import type {
  AbortMessageCommand,
  ApprovalResponseBody,
  ChangeDeviceStateCommand,
  ChannelAccountBindCommand,
  ChannelAccountCreateCommand,
  ChannelAccountDeleteCommand,
  ChannelAccountStartCommand,
  ChannelAccountStopCommand,
  ChannelAccountsListCommand,
  ChannelAccountUnbindCommand,
  ChannelAccountUpdateCommand,
  ChannelGetConfigCommand,
  ChannelPairingBindCommand,
  ChannelPairingsListCommand,
  ChannelRouteRemoveCommand,
  ChannelRoutesListCommand,
  ChannelRouteUpdateCommand,
  ChannelSetConfigCommand,
  ChannelStartCommand,
  ChannelStopCommand,
  ChannelsListCommand,
  ChannelTargetBindCommand,
  ChannelTargetsListCommand,
  CreateAgentCommand,
  CronAddCommand,
  CronDeleteAllCommand,
  CronDeleteCommand,
  CronGetCommand,
  CronListCommand,
  GetReflectionSettingsCommand,
  ListModelsResponseMessage,
  ListModelsResponseModelEntry,
  ReflectionSettingsScope,
  SetReflectionSettingsCommand,
  SkillDisableCommand,
  SkillEnableCommand,
  UpdateModelResponseMessage,
} from "../../types/protocol_v2";
import { isDebugEnabled } from "../../utils/debug";
import {
  handleTerminalInput,
  handleTerminalKill,
  handleTerminalResize,
  handleTerminalSpawn,
  killAllTerminals,
} from "../terminalHandler";
import {
  clearPendingApprovalBatchIds,
  rejectPendingApprovalResolvers,
  rememberPendingApprovalBatchIds,
  resolvePendingApprovalBatchId,
  resolvePendingApprovalResolver,
  resolveRecoveryBatchId,
} from "./approval";
import { handleExecuteCommand } from "./commands";
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  MAX_RETRY_DURATION_MS,
} from "./constants";
import {
  getConversationWorkingDirectory,
  loadPersistedCwdMap,
  setConversationWorkingDirectory,
} from "./cwd";
import {
  consumeInterruptQueue,
  emitInterruptToolReturnMessage,
  extractInterruptToolReturns,
  getInterruptApprovalsForEmission,
  normalizeExecutionResultsForInterruptParity,
  normalizeToolReturnWireMessage,
  populateInterruptQueue,
  stashRecoveredApprovalInterrupts,
} from "./interrupts";
import {
  getOrCreateConversationPermissionModeStateRef,
  loadPersistedPermissionModeMap,
  persistPermissionModeMapForRuntime,
} from "./permissionMode";
import {
  isChannelAccountBindCommand,
  isChannelAccountCreateCommand,
  isChannelAccountDeleteCommand,
  isChannelAccountStartCommand,
  isChannelAccountStopCommand,
  isChannelAccountsListCommand,
  isChannelAccountUnbindCommand,
  isChannelAccountUpdateCommand,
  isChannelGetConfigCommand,
  isChannelPairingBindCommand,
  isChannelPairingsListCommand,
  isChannelRouteRemoveCommand,
  isChannelRoutesListCommand,
  isChannelRouteUpdateCommand,
  isChannelSetConfigCommand,
  isChannelStartCommand,
  isChannelStopCommand,
  isChannelsListCommand,
  isChannelTargetBindCommand,
  isChannelTargetsListCommand,
  isCheckoutBranchCommand,
  isCreateAgentCommand,
  isCronAddCommand,
  isCronDeleteAllCommand,
  isCronDeleteCommand,
  isCronGetCommand,
  isCronListCommand,
  isEditFileCommand,
  isEnableMemfsCommand,
  isExecuteCommandCommand,
  isGetReflectionSettingsCommand,
  isListInDirectoryCommand,
  isListMemoryCommand,
  isListModelsCommand,
  isMemoryFileAtRefCommand,
  isMemoryHistoryCommand,
  isReadFileCommand,
  isSearchBranchesCommand,
  isSearchFilesCommand,
  isSetReflectionSettingsCommand,
  isSkillDisableCommand,
  isSkillEnableCommand,
  isUnwatchFileCommand,
  isUpdateModelCommand,
  isWatchFileCommand,
  isWriteFileCommand,
  parseServerMessage,
} from "./protocol-inbound";
import {
  buildDeviceStatus,
  buildLoopStatus,
  buildQueueSnapshot,
  emitDeviceStatusUpdate,
  emitInterruptedStatusDelta,
  emitLoopStatusUpdate,
  emitRetryDelta,
  emitRuntimeStateUpdates,
  emitStateSync,
  emitStatusDelta,
  emitStreamDelta,
  emitSubagentStateIfOpen,
  scheduleQueueEmit,
  setLoopStatus,
} from "./protocol-outbound";
import {
  consumeQueuedTurn,
  getQueueItemScope,
  getQueueItemsScope,
  normalizeInboundMessages,
  normalizeMessageContentImages,
  scheduleQueuePump,
  shouldQueueInboundMessage,
} from "./queue";
import { emitLoopErrorNotice } from "./recoverable-notices";
import {
  getApprovalContinuationRecoveryDisposition,
  recoverApprovalStateForSync,
  resolveRecoveredApprovalResponse,
  shouldAttemptPostStopApprovalRecovery,
} from "./recovery";
import {
  clearActiveRunState,
  clearConversationRuntimeState,
  clearRecoveredApprovalStateForScope,
  clearRuntimeTimers,
  emitListenerStatus,
  evictConversationRuntimeIfIdle,
  getActiveRuntime,
  getListenerStatus,
  getOrCreateConversationRuntime,
  getPendingControlRequestCount,
  getPendingControlRequests,
  getRecoveredApprovalStateForScope,
  safeEmitWsEvent,
  setActiveRuntime,
} from "./runtime";
import {
  normalizeConversationId,
  normalizeCwdAgentId,
  resolveRuntimeScope,
} from "./scope";
import {
  markAwaitingAcceptedApprovalContinuationRunId,
  resolveStaleApprovals,
} from "./send";
import { handleIncomingMessage } from "./turn";
import type {
  ChangeCwdMessage,
  ConversationRuntime,
  IncomingMessage,
  ListenerRuntime,
  ModeChangePayload,
  StartListenerOptions,
} from "./types";

type ChannelsServiceModule = typeof import("../../channels/service");

let channelsServiceLoaderOverride:
  | null
  | (() => Promise<ChannelsServiceModule>) = null;

async function loadChannelsService(): Promise<ChannelsServiceModule> {
  if (channelsServiceLoaderOverride) {
    return channelsServiceLoaderOverride();
  }
  return import("../../channels/service");
}

const WIKI_LINK_REGEX = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

function trackListenerError(
  errorType: string,
  error: unknown,
  context: string,
): void {
  trackBoundaryError({
    errorType,
    error,
    context,
  });
}

function safeSocketSend(
  socket: WebSocket,
  payload: unknown,
  errorType: string,
  context: string,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    const serialized =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    socket.send(serialized);
    return true;
  } catch (error) {
    trackListenerError(errorType, error, context);
    if (isDebugEnabled()) {
      console.error(`[Listen] ${context} send failed:`, error);
    }
    return false;
  }
}

function runDetachedListenerTask(
  commandName: string,
  task: () => Promise<void>,
): void {
  void task().catch((error) => {
    trackListenerError(
      `listener_${commandName}_failed`,
      error,
      `listener_${commandName}`,
    );
    if (isDebugEnabled()) {
      console.error(`[Listen] ${commandName} failed:`, error);
    }
  });
}

async function replaySyncStateForRuntime(
  listenerRuntime: ListenerRuntime,
  socket: WebSocket,
  scope: { agent_id: string; conversation_id: string },
  opts?: {
    recoverApprovalStateForSync?: (
      runtime: ConversationRuntime,
      scope: { agent_id: string; conversation_id: string },
    ) => Promise<void>;
  },
): Promise<void> {
  const syncScopedRuntime = getOrCreateScopedRuntime(
    listenerRuntime,
    scope.agent_id,
    scope.conversation_id,
  );
  const recoverFn =
    opts?.recoverApprovalStateForSync ?? recoverApprovalStateForSync;

  try {
    await recoverFn(syncScopedRuntime, scope);
  } catch (error) {
    trackListenerError(
      "listener_sync_recovery_failed",
      error,
      "listener_sync_recovery",
    );
    if (isDebugEnabled()) {
      console.warn("[Listen] Sync approval recovery failed:", error);
    }
  }

  emitStateSync(socket, listenerRuntime, scope);
}

function getParsedRuntimeScope(
  parsed: unknown,
): { agent_id: string; conversation_id: string } | null {
  if (!parsed || typeof parsed !== "object" || !("runtime" in parsed)) {
    return null;
  }

  const runtime = (
    parsed as {
      runtime?: { agent_id?: unknown; conversation_id?: unknown };
    }
  ).runtime;
  if (!runtime || typeof runtime.agent_id !== "string") {
    return null;
  }

  return {
    agent_id: runtime.agent_id,
    conversation_id:
      typeof runtime.conversation_id === "string"
        ? runtime.conversation_id
        : "default",
  };
}

/**
 * Handle mode change request from cloud.
 * Stores the new mode in ListenerRuntime.permissionModeByConversation so
 * each agent/conversation is isolated and the state outlives the ephemeral
 * ConversationRuntime (which gets evicted between turns).
 */
function handleModeChange(
  msg: ModeChangePayload,
  socket: WebSocket,
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  try {
    const agentId = scope?.agent_id ?? null;
    const conversationId = scope?.conversation_id ?? "default";
    const current = getOrCreateConversationPermissionModeStateRef(
      runtime,
      agentId,
      conversationId,
    );

    // Track previous mode so ExitPlanMode can restore it
    if (msg.mode === "plan" && current.mode !== "plan") {
      current.modeBeforePlan = current.mode;
    }
    current.mode = msg.mode;

    // Generate plan file path when entering plan mode
    if (msg.mode === "plan" && !current.planFilePath) {
      current.planFilePath = generatePlanFilePath();
    }

    // Clear plan-related state when leaving plan mode
    if (msg.mode !== "plan") {
      current.planFilePath = null;
      current.modeBeforePlan = null;
    }

    persistPermissionModeMapForRuntime(runtime);

    emitRuntimeStateUpdates(runtime, scope);

    if (isDebugEnabled()) {
      console.log(`[Listen] Mode changed to: ${msg.mode}`);
    }
  } catch (error) {
    trackListenerError(
      "listener_mode_change_failed",
      error,
      "listener_mode_change",
    );
    emitLoopErrorNotice(socket, runtime, {
      message: error instanceof Error ? error.message : "Mode change failed",
      stopReason: "error",
      isTerminal: false,
      agentId: scope?.agent_id,
      conversationId: scope?.conversation_id,
      error,
    });

    if (isDebugEnabled()) {
      console.error("[Listen] Mode change failed:", error);
    }
  }
}

type CronCommand =
  | CronListCommand
  | CronAddCommand
  | CronGetCommand
  | CronDeleteCommand
  | CronDeleteAllCommand;

type ResolvedModelForUpdate = {
  id: string;
  handle: string;
  label: string;
  updateArgs?: Record<string, unknown>;
};

function resolveModelForUpdate(payload: {
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

function formatEffortSuffix(updateArgs?: Record<string, unknown>): string {
  if (!updateArgs) return "";
  const effort = updateArgs.reasoning_effort;
  if (typeof effort !== "string" || effort.length === 0) return "";
  const labels: Record<string, string> = {
    none: "No Reasoning",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Max",
  };
  return ` (${labels[effort] ?? effort})`;
}

function buildModelUpdateStatusMessage(params: {
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
  let message = `Model updated to ${modelLabel}${formatEffortSuffix(updateArgs)}.`;
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

async function applyModelUpdateForRuntime(params: {
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
    const preparedToolContext =
      await prepareToolExecutionContextForResolvedTarget({
        modelIdentifier: model.handle,
        toolsetPreference,
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

  // Only mention toolset in the status message when it actually changed
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

function buildListModelsEntries(): ListModelsResponseModelEntry[] {
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
async function buildListModelsResponse(
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

type ReflectionSettingsCommand =
  | GetReflectionSettingsCommand
  | SetReflectionSettingsCommand;

type ChannelsCommand =
  | ChannelsListCommand
  | ChannelAccountsListCommand
  | ChannelAccountCreateCommand
  | ChannelAccountUpdateCommand
  | ChannelAccountBindCommand
  | ChannelAccountUnbindCommand
  | ChannelAccountDeleteCommand
  | ChannelAccountStartCommand
  | ChannelAccountStopCommand
  | ChannelGetConfigCommand
  | ChannelSetConfigCommand
  | ChannelStartCommand
  | ChannelStopCommand
  | ChannelPairingsListCommand
  | ChannelPairingBindCommand
  | ChannelRoutesListCommand
  | ChannelTargetsListCommand
  | ChannelTargetBindCommand
  | ChannelRouteUpdateCommand
  | ChannelRouteRemoveCommand;

function isDetachedChannelsCommand(parsed: unknown): parsed is ChannelsCommand {
  return (
    isChannelsListCommand(parsed) ||
    isChannelAccountsListCommand(parsed) ||
    isChannelAccountCreateCommand(parsed) ||
    isChannelAccountUpdateCommand(parsed) ||
    isChannelAccountBindCommand(parsed) ||
    isChannelAccountUnbindCommand(parsed) ||
    isChannelAccountDeleteCommand(parsed) ||
    isChannelAccountStartCommand(parsed) ||
    isChannelAccountStopCommand(parsed) ||
    isChannelGetConfigCommand(parsed) ||
    isChannelSetConfigCommand(parsed) ||
    isChannelStartCommand(parsed) ||
    isChannelStopCommand(parsed) ||
    isChannelPairingsListCommand(parsed) ||
    isChannelPairingBindCommand(parsed) ||
    isChannelRoutesListCommand(parsed) ||
    isChannelTargetsListCommand(parsed) ||
    isChannelTargetBindCommand(parsed) ||
    isChannelRouteUpdateCommand(parsed) ||
    isChannelRouteRemoveCommand(parsed)
  );
}

function emitCronsUpdated(
  socket: WebSocket,
  scope?: { agent_id?: string; conversation_id?: string | null },
): void {
  safeSocketSend(
    socket,
    {
      type: "crons_updated",
      timestamp: Date.now(),
      ...(scope?.agent_id ? { agent_id: scope.agent_id } : {}),
      ...(scope?.conversation_id !== undefined
        ? { conversation_id: scope.conversation_id }
        : {}),
    },
    "listener_cron_send_failed",
    "listener_cron_command",
  );
}

function emitChannelsUpdated(
  socket: WebSocket,
  channelId?: "telegram" | "slack",
): void {
  safeSocketSend(
    socket,
    {
      type: "channels_updated",
      timestamp: Date.now(),
      ...(channelId ? { channel_id: channelId } : {}),
    },
    "listener_channels_send_failed",
    "listener_channels_command",
  );
}

function emitChannelAccountsUpdated(
  socket: WebSocket,
  params: { channelId: "telegram" | "slack"; accountId?: string },
): void {
  safeSocketSend(
    socket,
    {
      type: "channel_accounts_updated",
      timestamp: Date.now(),
      channel_id: params.channelId,
      ...(params.accountId ? { account_id: params.accountId } : {}),
    },
    "listener_channels_send_failed",
    "listener_channels_command",
  );
}

function emitChannelPairingsUpdated(
  socket: WebSocket,
  channelId: "telegram" | "slack",
): void {
  safeSocketSend(
    socket,
    {
      type: "channel_pairings_updated",
      timestamp: Date.now(),
      channel_id: channelId,
    },
    "listener_channels_send_failed",
    "listener_channels_command",
  );
}

function emitChannelRoutesUpdated(
  socket: WebSocket,
  params: {
    channelId: "telegram" | "slack";
    agentId?: string;
    conversationId?: string | null;
  },
): void {
  safeSocketSend(
    socket,
    {
      type: "channel_routes_updated",
      timestamp: Date.now(),
      channel_id: params.channelId,
      ...(params.agentId ? { agent_id: params.agentId } : {}),
      ...(params.conversationId !== undefined
        ? { conversation_id: params.conversationId }
        : {}),
    },
    "listener_channels_send_failed",
    "listener_channels_command",
  );
}

function emitChannelTargetsUpdated(
  socket: WebSocket,
  channelId: "telegram" | "slack",
): void {
  safeSocketSend(
    socket,
    {
      type: "channel_targets_updated",
      timestamp: Date.now(),
      channel_id: channelId,
    },
    "listener_channels_send_failed",
    "listener_channels_command",
  );
}

async function handleCronCommand(
  parsed: CronCommand,
  socket: WebSocket,
): Promise<boolean> {
  if (parsed.type === "cron_list") {
    try {
      const tasks = listCronTasks({
        agent_id: parsed.agent_id,
        conversation_id: parsed.conversation_id,
      });
      safeSocketSend(
        socket,
        {
          type: "cron_list_response",
          request_id: parsed.request_id,
          tasks,
          success: true,
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "cron_list_response",
          request_id: parsed.request_id,
          tasks: [],
          success: false,
          error: err instanceof Error ? err.message : "Failed to list crons",
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  if (parsed.type === "cron_add") {
    try {
      const scheduledFor = parsed.scheduled_for
        ? new Date(parsed.scheduled_for)
        : undefined;
      if (scheduledFor && Number.isNaN(scheduledFor.getTime())) {
        throw new Error("Invalid scheduled_for timestamp");
      }
      const result = addCronTask({
        agent_id: parsed.agent_id,
        conversation_id: parsed.conversation_id,
        name: parsed.name,
        description: parsed.description,
        cron: parsed.cron,
        timezone: parsed.timezone,
        recurring: parsed.recurring,
        prompt: parsed.prompt,
        scheduled_for: scheduledFor,
      });
      safeSocketSend(
        socket,
        {
          type: "cron_add_response",
          request_id: parsed.request_id,
          success: true,
          task: result.task,
          ...(result.warning ? { warning: result.warning } : {}),
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
      emitCronsUpdated(socket, {
        agent_id: result.task.agent_id,
        conversation_id: result.task.conversation_id,
      });
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "cron_add_response",
          request_id: parsed.request_id,
          success: false,
          error: err instanceof Error ? err.message : "Failed to add cron",
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  if (parsed.type === "cron_get") {
    try {
      const task = getCronTask(parsed.task_id);
      safeSocketSend(
        socket,
        {
          type: "cron_get_response",
          request_id: parsed.request_id,
          success: true,
          found: task !== null,
          task,
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "cron_get_response",
          request_id: parsed.request_id,
          success: false,
          found: false,
          task: null,
          error: err instanceof Error ? err.message : "Failed to get cron",
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  if (parsed.type === "cron_delete") {
    try {
      const existingTask = getCronTask(parsed.task_id);
      const found = deleteCronTask(parsed.task_id);
      safeSocketSend(
        socket,
        {
          type: "cron_delete_response",
          request_id: parsed.request_id,
          success: true,
          found,
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
      if (found) {
        emitCronsUpdated(socket, {
          agent_id: existingTask?.agent_id,
          conversation_id: existingTask?.conversation_id,
        });
      }
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "cron_delete_response",
          request_id: parsed.request_id,
          success: false,
          found: false,
          error: err instanceof Error ? err.message : "Failed to delete cron",
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  try {
    const deleted = deleteAllCronTasks(parsed.agent_id);
    safeSocketSend(
      socket,
      {
        type: "cron_delete_all_response",
        request_id: parsed.request_id,
        success: true,
        agent_id: parsed.agent_id,
        deleted,
      },
      "listener_cron_send_failed",
      "listener_cron_command",
    );
    if (deleted > 0) {
      emitCronsUpdated(socket, {
        agent_id: parsed.agent_id,
      });
    }
  } catch (err) {
    safeSocketSend(
      socket,
      {
        type: "cron_delete_all_response",
        request_id: parsed.request_id,
        success: false,
        agent_id: parsed.agent_id,
        deleted: 0,
        error: err instanceof Error ? err.message : "Failed to delete crons",
      },
      "listener_cron_send_failed",
      "listener_cron_command",
    );
  }
  return true;
}

async function handleChannelsProtocolCommand(
  parsed: ChannelsCommand,
  socket: WebSocket,
  runtime: ListenerRuntime,
  opts: Pick<StartListenerOptions, "onStatusChange" | "connectionId">,
  processQueuedTurn: ProcessQueuedTurn,
): Promise<boolean> {
  const {
    bindChannelPairing,
    bindChannelAccountLive,
    bindChannelTarget,
    createChannelAccountLive,
    refreshChannelAccountDisplayNameLive,
    getChannelConfigSnapshot,
    listChannelAccountSnapshots,
    listChannelRouteSnapshots,
    listChannelSummaries,
    listPendingPairingSnapshots,
    listChannelTargetSnapshots,
    removeChannelAccountLive,
    removeChannelRouteLive,
    setChannelConfigLive,
    startChannelAccountLive,
    startChannelLive,
    stopChannelAccountLive,
    stopChannelLive,
    unbindChannelAccountLive,
    updateChannelAccountLive,
    updateChannelRouteLive,
  } = await loadChannelsService();

  const mapChannelSummary = (
    summary: ReturnType<typeof listChannelSummaries>[number],
  ) => ({
    channel_id: summary.channelId,
    display_name: summary.displayName,
    configured: summary.configured,
    enabled: summary.enabled,
    running: summary.running,
    dm_policy: summary.dmPolicy,
    pending_pairings_count: summary.pendingPairingsCount,
    approved_users_count: summary.approvedUsersCount,
    routes_count: summary.routesCount,
  });

  const mapChannelConfig = (
    snapshot: ReturnType<typeof getChannelConfigSnapshot>,
  ) => {
    if (!snapshot) {
      return null;
    }
    if (snapshot.channelId === "telegram") {
      return {
        channel_id: snapshot.channelId,
        account_id: snapshot.accountId,
        display_name: snapshot.displayName,
        enabled: snapshot.enabled,
        dm_policy: snapshot.dmPolicy,
        allowed_users: snapshot.allowedUsers,
        has_token: snapshot.hasToken,
      };
    }
    return {
      channel_id: snapshot.channelId,
      account_id: snapshot.accountId,
      display_name: snapshot.displayName,
      enabled: snapshot.enabled,
      mode: snapshot.mode,
      dm_policy: snapshot.dmPolicy,
      allowed_users: snapshot.allowedUsers,
      has_bot_token: snapshot.hasBotToken,
      has_app_token: snapshot.hasAppToken,
    };
  };

  const mapChannelAccount = (
    snapshot: ReturnType<typeof listChannelAccountSnapshots>[number],
  ) => {
    if (snapshot.channelId === "telegram") {
      return {
        channel_id: snapshot.channelId,
        account_id: snapshot.accountId,
        display_name: snapshot.displayName,
        enabled: snapshot.enabled,
        configured: snapshot.configured,
        running: snapshot.running,
        dm_policy: snapshot.dmPolicy,
        allowed_users: snapshot.allowedUsers,
        has_token: snapshot.hasToken,
        binding: {
          agent_id: snapshot.binding.agentId,
          conversation_id: snapshot.binding.conversationId,
        },
        created_at: snapshot.createdAt,
        updated_at: snapshot.updatedAt,
      };
    }

    return {
      channel_id: snapshot.channelId,
      account_id: snapshot.accountId,
      display_name: snapshot.displayName,
      enabled: snapshot.enabled,
      configured: snapshot.configured,
      running: snapshot.running,
      mode: snapshot.mode,
      dm_policy: snapshot.dmPolicy,
      allowed_users: snapshot.allowedUsers,
      has_bot_token: snapshot.hasBotToken,
      has_app_token: snapshot.hasAppToken,
      agent_id: snapshot.agentId,
      created_at: snapshot.createdAt,
      updated_at: snapshot.updatedAt,
    };
  };

  const mapRouteSnapshot = (
    route: ReturnType<typeof listChannelRouteSnapshots>[number],
  ) => ({
    channel_id: route.channelId,
    account_id: route.accountId,
    chat_id: route.chatId,
    chat_type: route.chatType,
    thread_id: route.threadId ?? null,
    agent_id: route.agentId,
    conversation_id: route.conversationId,
    enabled: route.enabled,
    created_at: route.createdAt,
    updated_at: route.updatedAt,
  });

  const mapTargetSnapshot = (
    target: ReturnType<typeof listChannelTargetSnapshots>[number],
  ) => ({
    channel_id: target.channelId,
    account_id: target.accountId,
    target_id: target.targetId,
    target_type: target.targetType,
    chat_id: target.chatId,
    label: target.label,
    discovered_at: target.discoveredAt,
    last_seen_at: target.lastSeenAt,
    ...(target.lastMessageId ? { last_message_id: target.lastMessageId } : {}),
  });

  if (parsed.type === "channels_list") {
    try {
      safeSocketSend(
        socket,
        {
          type: "channels_list_response",
          request_id: parsed.request_id,
          success: true,
          channels: listChannelSummaries().map(mapChannelSummary),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channels_list_response",
          request_id: parsed.request_id,
          success: false,
          channels: [],
          error: err instanceof Error ? err.message : "Failed to list channels",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_accounts_list") {
    try {
      const accounts = await Promise.all(
        listChannelAccountSnapshots(parsed.channel_id).map((account) =>
          parsed.channel_id === "slack"
            ? refreshChannelAccountDisplayNameLive(
                parsed.channel_id,
                account.accountId,
                { force: true },
              )
            : account.displayName
              ? Promise.resolve(account)
              : refreshChannelAccountDisplayNameLive(
                  parsed.channel_id,
                  account.accountId,
                ),
        ),
      );
      safeSocketSend(
        socket,
        {
          type: "channel_accounts_list_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          accounts: accounts.map(mapChannelAccount),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_accounts_list_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          accounts: [],
          error:
            err instanceof Error
              ? err.message
              : "Failed to list channel accounts",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_account_create") {
    try {
      const created = createChannelAccountLive(
        parsed.channel_id,
        {
          displayName:
            "display_name" in parsed.account
              ? parsed.account.display_name
              : undefined,
          enabled:
            "enabled" in parsed.account ? parsed.account.enabled : undefined,
          token: "token" in parsed.account ? parsed.account.token : undefined,
          botToken:
            "bot_token" in parsed.account
              ? parsed.account.bot_token
              : undefined,
          appToken:
            "app_token" in parsed.account
              ? parsed.account.app_token
              : undefined,
          mode: "mode" in parsed.account ? parsed.account.mode : undefined,
          agentId:
            "agent_id" in parsed.account ? parsed.account.agent_id : undefined,
          dmPolicy: parsed.account.dm_policy,
          allowedUsers: parsed.account.allowed_users,
        },
        {
          accountId:
            "account_id" in parsed.account
              ? parsed.account.account_id
              : undefined,
        },
      );
      const account =
        "display_name" in parsed.account
          ? created
          : await refreshChannelAccountDisplayNameLive(
              parsed.channel_id,
              created.accountId,
              { force: true },
            );

      safeSocketSend(
        socket,
        {
          type: "channel_account_create_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          account: mapChannelAccount(account),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, {
        channelId: parsed.channel_id,
        accountId: account.accountId,
      });
      emitChannelsUpdated(socket, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_account_create_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          account: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to create channel account",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_account_update") {
    try {
      const updated = updateChannelAccountLive(
        parsed.channel_id,
        parsed.account_id,
        {
          displayName:
            "display_name" in parsed.patch
              ? parsed.patch.display_name
              : undefined,
          enabled: "enabled" in parsed.patch ? parsed.patch.enabled : undefined,
          token: "token" in parsed.patch ? parsed.patch.token : undefined,
          botToken:
            "bot_token" in parsed.patch ? parsed.patch.bot_token : undefined,
          appToken:
            "app_token" in parsed.patch ? parsed.patch.app_token : undefined,
          mode: "mode" in parsed.patch ? parsed.patch.mode : undefined,
          agentId:
            "agent_id" in parsed.patch ? parsed.patch.agent_id : undefined,
          dmPolicy: parsed.patch.dm_policy,
          allowedUsers: parsed.patch.allowed_users,
        },
      );
      const shouldRefreshDisplayName =
        !("display_name" in parsed.patch) &&
        (parsed.channel_id === "telegram"
          ? "token" in parsed.patch
          : "bot_token" in parsed.patch || "app_token" in parsed.patch);
      const account = shouldRefreshDisplayName
        ? await refreshChannelAccountDisplayNameLive(
            parsed.channel_id,
            parsed.account_id,
            { force: true },
          )
        : updated;

      safeSocketSend(
        socket,
        {
          type: "channel_account_update_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          account: mapChannelAccount(account),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, {
        channelId: parsed.channel_id,
        accountId: parsed.account_id,
      });
      emitChannelsUpdated(socket, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_account_update_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          account: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to update channel account",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_account_bind") {
    try {
      const account = bindChannelAccountLive(
        parsed.channel_id,
        parsed.account_id,
        parsed.runtime.agent_id,
        parsed.runtime.conversation_id,
      );

      safeSocketSend(
        socket,
        {
          type: "channel_account_bind_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          account: mapChannelAccount(account),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, {
        channelId: parsed.channel_id,
        accountId: parsed.account_id,
      });
      emitChannelsUpdated(socket, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_account_bind_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          account: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to bind channel account",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_account_unbind") {
    try {
      const account = unbindChannelAccountLive(
        parsed.channel_id,
        parsed.account_id,
      );

      safeSocketSend(
        socket,
        {
          type: "channel_account_unbind_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          account: mapChannelAccount(account),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, {
        channelId: parsed.channel_id,
        accountId: parsed.account_id,
      });
      emitChannelsUpdated(socket, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_account_unbind_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          account: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to unbind channel account",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_account_delete") {
    try {
      const deleted = await removeChannelAccountLive(
        parsed.channel_id,
        parsed.account_id,
      );

      safeSocketSend(
        socket,
        {
          type: "channel_account_delete_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          account_id: parsed.account_id,
          deleted,
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      if (deleted) {
        emitChannelAccountsUpdated(socket, {
          channelId: parsed.channel_id,
          accountId: parsed.account_id,
        });
        emitChannelPairingsUpdated(socket, parsed.channel_id);
        emitChannelRoutesUpdated(socket, {
          channelId: parsed.channel_id,
        });
        emitChannelTargetsUpdated(socket, parsed.channel_id);
        emitChannelsUpdated(socket, parsed.channel_id);
      }
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_account_delete_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          account_id: parsed.account_id,
          deleted: false,
          error:
            err instanceof Error
              ? err.message
              : "Failed to delete channel account",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_account_start") {
    try {
      const account = await startChannelAccountLive(
        parsed.channel_id,
        parsed.account_id,
      );
      wireChannelIngress(
        runtime,
        socket,
        opts as StartListenerOptions,
        processQueuedTurn,
      );
      safeSocketSend(
        socket,
        {
          type: "channel_account_start_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          account: mapChannelAccount(account),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, {
        channelId: parsed.channel_id,
        accountId: parsed.account_id,
      });
      emitChannelsUpdated(socket, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_account_start_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          account: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to start channel account",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_account_stop") {
    try {
      const account = await stopChannelAccountLive(
        parsed.channel_id,
        parsed.account_id,
      );
      safeSocketSend(
        socket,
        {
          type: "channel_account_stop_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          account: mapChannelAccount(account),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, {
        channelId: parsed.channel_id,
        accountId: parsed.account_id,
      });
      emitChannelsUpdated(socket, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_account_stop_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          account: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to stop channel account",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_get_config") {
    try {
      safeSocketSend(
        socket,
        {
          type: "channel_get_config_response",
          request_id: parsed.request_id,
          success: true,
          config: mapChannelConfig(
            getChannelConfigSnapshot(parsed.channel_id, parsed.account_id),
          ),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_get_config_response",
          request_id: parsed.request_id,
          success: false,
          config: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to read channel config",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_set_config") {
    try {
      const snapshot = await setChannelConfigLive(
        parsed.channel_id,
        {
          token: "token" in parsed.config ? parsed.config.token : undefined,
          botToken:
            "bot_token" in parsed.config ? parsed.config.bot_token : undefined,
          appToken:
            "app_token" in parsed.config ? parsed.config.app_token : undefined,
          mode: "mode" in parsed.config ? parsed.config.mode : undefined,
          dmPolicy: parsed.config.dm_policy,
          allowedUsers: parsed.config.allowed_users,
        },
        parsed.account_id,
      );

      if (snapshot.enabled) {
        wireChannelIngress(
          runtime,
          socket,
          opts as StartListenerOptions,
          processQueuedTurn,
        );
      }

      safeSocketSend(
        socket,
        {
          type: "channel_set_config_response",
          request_id: parsed.request_id,
          success: true,
          config: mapChannelConfig(snapshot),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, {
        channelId: parsed.channel_id,
        accountId: snapshot.accountId,
      });
      emitChannelsUpdated(socket, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_set_config_response",
          request_id: parsed.request_id,
          success: false,
          config: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to update channel config",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_start") {
    try {
      const summary = await startChannelLive(
        parsed.channel_id,
        parsed.account_id,
      );
      wireChannelIngress(
        runtime,
        socket,
        opts as StartListenerOptions,
        processQueuedTurn,
      );
      safeSocketSend(
        socket,
        {
          type: "channel_start_response",
          request_id: parsed.request_id,
          success: true,
          channel: mapChannelSummary(summary),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelsUpdated(socket, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_start_response",
          request_id: parsed.request_id,
          success: false,
          channel: null,
          error: err instanceof Error ? err.message : "Failed to start channel",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_stop") {
    try {
      const summary = await stopChannelLive(
        parsed.channel_id,
        parsed.account_id,
      );
      safeSocketSend(
        socket,
        {
          type: "channel_stop_response",
          request_id: parsed.request_id,
          success: true,
          channel: mapChannelSummary(summary),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelsUpdated(socket, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_stop_response",
          request_id: parsed.request_id,
          success: false,
          channel: null,
          error: err instanceof Error ? err.message : "Failed to stop channel",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_pairings_list") {
    try {
      safeSocketSend(
        socket,
        {
          type: "channel_pairings_list_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          pending: listPendingPairingSnapshots(
            parsed.channel_id,
            parsed.account_id,
          ).map((pending) => ({
            account_id: pending.accountId,
            code: pending.code,
            sender_id: pending.senderId,
            sender_name: pending.senderName,
            chat_id: pending.chatId,
            created_at: pending.createdAt,
            expires_at: pending.expiresAt,
          })),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_pairings_list_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          pending: [],
          error:
            err instanceof Error
              ? err.message
              : "Failed to list pending pairings",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_pairing_bind") {
    try {
      const result = bindChannelPairing(
        parsed.channel_id,
        parsed.code,
        parsed.runtime.agent_id,
        parsed.runtime.conversation_id,
        parsed.account_id,
      );
      safeSocketSend(
        socket,
        {
          type: "channel_pairing_bind_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          chat_id: result.chatId,
          route: mapRouteSnapshot(result.route),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelPairingsUpdated(socket, parsed.channel_id);
      emitChannelRoutesUpdated(socket, {
        channelId: parsed.channel_id,
        agentId: parsed.runtime.agent_id,
        conversationId: parsed.runtime.conversation_id,
      });
      emitChannelsUpdated(socket, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_pairing_bind_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          route: null,
          error: err instanceof Error ? err.message : "Failed to bind pairing",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_routes_list") {
    try {
      const channelId = parsed.channel_id ?? "telegram";
      safeSocketSend(
        socket,
        {
          type: "channel_routes_list_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: channelId,
          routes: listChannelRouteSnapshots({
            channelId,
            accountId: parsed.account_id,
            agentId: parsed.agent_id,
            conversationId: parsed.conversation_id,
          }).map(mapRouteSnapshot),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_routes_list_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          routes: [],
          error: err instanceof Error ? err.message : "Failed to list routes",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_targets_list") {
    try {
      safeSocketSend(
        socket,
        {
          type: "channel_targets_list_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          targets: listChannelTargetSnapshots(
            parsed.channel_id,
            parsed.account_id,
          ).map(mapTargetSnapshot),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_targets_list_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          targets: [],
          error:
            err instanceof Error
              ? err.message
              : "Failed to list channel targets",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_target_bind") {
    try {
      const result = bindChannelTarget(
        parsed.channel_id,
        parsed.target_id,
        parsed.runtime.agent_id,
        parsed.runtime.conversation_id,
        parsed.account_id,
      );
      safeSocketSend(
        socket,
        {
          type: "channel_target_bind_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          target_id: parsed.target_id,
          chat_id: result.chatId,
          route: mapRouteSnapshot(result.route),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelTargetsUpdated(socket, parsed.channel_id);
      emitChannelRoutesUpdated(socket, {
        channelId: parsed.channel_id,
        agentId: parsed.runtime.agent_id,
        conversationId: parsed.runtime.conversation_id,
      });
      emitChannelsUpdated(socket, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_target_bind_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          target_id: parsed.target_id,
          route: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to bind channel target",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  if (parsed.type === "channel_route_update") {
    try {
      const route = updateChannelRouteLive(
        parsed.channel_id,
        parsed.chat_id,
        parsed.runtime.agent_id,
        parsed.runtime.conversation_id,
        parsed.account_id,
      );
      safeSocketSend(
        socket,
        {
          type: "channel_route_update_response",
          request_id: parsed.request_id,
          success: true,
          channel_id: parsed.channel_id,
          chat_id: parsed.chat_id,
          route: mapRouteSnapshot(route),
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
      emitChannelAccountsUpdated(socket, {
        channelId: parsed.channel_id,
        accountId: route.accountId,
      });
      emitChannelRoutesUpdated(socket, {
        channelId: parsed.channel_id,
        agentId: parsed.runtime.agent_id,
        conversationId: parsed.runtime.conversation_id,
      });
      emitChannelsUpdated(socket, parsed.channel_id);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "channel_route_update_response",
          request_id: parsed.request_id,
          success: false,
          channel_id: parsed.channel_id,
          chat_id: parsed.chat_id,
          route: null,
          error: err instanceof Error ? err.message : "Failed to update route",
        },
        "listener_channels_send_failed",
        "listener_channels_command",
      );
    }
    return true;
  }

  try {
    const found = removeChannelRouteLive(
      parsed.channel_id,
      parsed.chat_id,
      parsed.account_id,
    );
    safeSocketSend(
      socket,
      {
        type: "channel_route_remove_response",
        request_id: parsed.request_id,
        success: true,
        channel_id: parsed.channel_id,
        chat_id: parsed.chat_id,
        found,
      },
      "listener_channels_send_failed",
      "listener_channels_command",
    );
    if (found) {
      emitChannelRoutesUpdated(socket, {
        channelId: parsed.channel_id,
      });
      emitChannelsUpdated(socket, parsed.channel_id);
    }
  } catch (err) {
    safeSocketSend(
      socket,
      {
        type: "channel_route_remove_response",
        request_id: parsed.request_id,
        success: false,
        channel_id: parsed.channel_id,
        chat_id: parsed.chat_id,
        found: false,
        error: err instanceof Error ? err.message : "Failed to remove route",
      },
      "listener_channels_send_failed",
      "listener_channels_command",
    );
  }

  return true;
}

type SkillCommand = SkillEnableCommand | SkillDisableCommand;

function emitSkillsUpdated(socket: WebSocket): void {
  safeSocketSend(
    socket,
    {
      type: "skills_updated",
      timestamp: Date.now(),
    },
    "listener_skill_send_failed",
    "listener_skill_command",
  );
}

async function handleSkillCommand(
  parsed: SkillCommand,
  socket: WebSocket,
): Promise<boolean> {
  const {
    existsSync,
    lstatSync,
    mkdirSync,
    rmdirSync,
    symlinkSync,
    unlinkSync,
  } = await import("node:fs");
  const { basename, join } = await import("node:path");

  // Compute skills dir dynamically to respect LETTA_HOME (important for tests)
  const lettaHome =
    process.env.LETTA_HOME ||
    join(process.env.HOME || process.env.USERPROFILE || "~", ".letta");
  const globalSkillsDir = join(lettaHome, "skills");

  if (parsed.type === "skill_enable") {
    try {
      // Validate the skill path exists
      if (!existsSync(parsed.skill_path)) {
        safeSocketSend(
          socket,
          {
            type: "skill_enable_response",
            request_id: parsed.request_id,
            success: false,
            error: `Path does not exist: ${parsed.skill_path}`,
          },
          "listener_skill_send_failed",
          "listener_skill_command",
        );
        return true;
      }

      // Check it contains a SKILL.md
      const skillMdPath = join(parsed.skill_path, "SKILL.md");
      if (!existsSync(skillMdPath)) {
        safeSocketSend(
          socket,
          {
            type: "skill_enable_response",
            request_id: parsed.request_id,
            success: false,
            error: `No SKILL.md found in ${parsed.skill_path}`,
          },
          "listener_skill_send_failed",
          "listener_skill_command",
        );
        return true;
      }

      const linkName = basename(parsed.skill_path);
      const linkPath = join(globalSkillsDir, linkName);

      // Ensure ~/.letta/skills/ exists
      mkdirSync(globalSkillsDir, { recursive: true });

      // If symlink/junction already exists, remove it first
      if (existsSync(linkPath)) {
        const stat = lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          if (process.platform === "win32") {
            rmdirSync(linkPath);
          } else {
            unlinkSync(linkPath);
          }
        } else {
          safeSocketSend(
            socket,
            {
              type: "skill_enable_response",
              request_id: parsed.request_id,
              success: false,
              error: `${linkPath} already exists and is not a symlink — refusing to overwrite`,
            },
            "listener_skill_send_failed",
            "listener_skill_command",
          );
          return true;
        }
      }

      // Use junctions on Windows — they don't require admin/Developer Mode
      const linkType = process.platform === "win32" ? "junction" : "dir";
      symlinkSync(parsed.skill_path, linkPath, linkType);

      safeSocketSend(
        socket,
        {
          type: "skill_enable_response",
          request_id: parsed.request_id,
          success: true,
          name: linkName,
          skill_path: parsed.skill_path,
          link_path: linkPath,
        },
        "listener_skill_send_failed",
        "listener_skill_command",
      );
      emitSkillsUpdated(socket);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "skill_enable_response",
          request_id: parsed.request_id,
          success: false,
          error: err instanceof Error ? err.message : "Failed to enable skill",
        },
        "listener_skill_send_failed",
        "listener_skill_command",
      );
    }
    return true;
  }

  if (parsed.type === "skill_disable") {
    try {
      const linkPath = join(globalSkillsDir, parsed.name);

      if (!existsSync(linkPath)) {
        safeSocketSend(
          socket,
          {
            type: "skill_disable_response",
            request_id: parsed.request_id,
            success: false,
            error: `Skill not found: ${parsed.name}`,
          },
          "listener_skill_send_failed",
          "listener_skill_command",
        );
        return true;
      }

      const stat = lstatSync(linkPath);
      if (!stat.isSymbolicLink()) {
        safeSocketSend(
          socket,
          {
            type: "skill_disable_response",
            request_id: parsed.request_id,
            success: false,
            error: `${parsed.name} is not a symlink — refusing to delete. Remove it manually if intended.`,
          },
          "listener_skill_send_failed",
          "listener_skill_command",
        );
        return true;
      }

      if (process.platform === "win32") {
        rmdirSync(linkPath);
      } else {
        unlinkSync(linkPath);
      }

      safeSocketSend(
        socket,
        {
          type: "skill_disable_response",
          request_id: parsed.request_id,
          success: true,
          name: parsed.name,
        },
        "listener_skill_send_failed",
        "listener_skill_command",
      );
      emitSkillsUpdated(socket);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "skill_disable_response",
          request_id: parsed.request_id,
          success: false,
          error: err instanceof Error ? err.message : "Failed to disable skill",
        },
        "listener_skill_send_failed",
        "listener_skill_command",
      );
    }
    return true;
  }

  return false;
}

async function handleCreateAgentCommand(
  parsed: CreateAgentCommand,
  socket: WebSocket,
): Promise<void> {
  try {
    // Pre-validate model so invalid requests soft-fail before createAgent().
    if (parsed.model) {
      const resolved = resolveModel(parsed.model);
      if (!resolved) {
        safeSocketSend(
          socket,
          {
            type: "create_agent_response",
            request_id: parsed.request_id,
            success: false,
            error: `Unknown model "${parsed.model}"`,
          },
          "listener_create_agent_send_failed",
          "listener_create_agent",
        );
        return;
      }
    }

    const { createAgentForPersonality } = await import(
      "../../agent/personality"
    );
    const result = await createAgentForPersonality({
      personalityId: parsed.personality,
      model: parsed.model,
    });

    // Pin the agent globally (favorites it) unless explicitly disabled
    if (parsed.pin_global !== false) {
      settingsManager.pinGlobal(result.agent.id);
    }

    safeSocketSend(
      socket,
      {
        type: "create_agent_response",
        request_id: parsed.request_id,
        success: true,
        agent_id: result.agent.id,
        name: result.agent.name,
        model: result.agent.model ?? null,
      },
      "listener_create_agent_send_failed",
      "listener_create_agent",
    );
  } catch (err) {
    safeSocketSend(
      socket,
      {
        type: "create_agent_response",
        request_id: parsed.request_id,
        success: false,
        error: err instanceof Error ? err.message : "Failed to create agent",
      },
      "listener_create_agent_send_failed",
      "listener_create_agent",
    );
  }
}

function toReflectionSettingsResponse(
  agentId: string,
  workingDirectory: string,
): {
  agent_id: string;
  trigger: "off" | "step-count" | "compaction-event";
  step_count: number;
} {
  const settings = getReflectionSettings(agentId, workingDirectory);
  return {
    agent_id: agentId,
    trigger: settings.trigger,
    step_count: settings.stepCount,
  };
}

function resolveReflectionSettingsScope(
  scope: ReflectionSettingsScope | undefined,
): {
  persistLocalProject: boolean;
  persistGlobal: boolean;
  normalizedScope: ReflectionSettingsScope;
} {
  if (scope === "local_project") {
    return {
      persistLocalProject: true,
      persistGlobal: false,
      normalizedScope: scope,
    };
  }
  if (scope === "global") {
    return {
      persistLocalProject: false,
      persistGlobal: true,
      normalizedScope: scope,
    };
  }
  return {
    persistLocalProject: true,
    persistGlobal: true,
    normalizedScope: "both",
  };
}

async function handleReflectionSettingsCommand(
  parsed: ReflectionSettingsCommand,
  socket: WebSocket,
  listener: ListenerRuntime,
): Promise<boolean> {
  const agentId = parsed.runtime.agent_id;
  const workingDirectory = getConversationWorkingDirectory(
    listener,
    parsed.runtime.agent_id,
    parsed.runtime.conversation_id,
  );

  if (parsed.type === "get_reflection_settings") {
    try {
      safeSocketSend(
        socket,
        {
          type: "get_reflection_settings_response",
          request_id: parsed.request_id,
          success: true,
          reflection_settings: toReflectionSettingsResponse(
            agentId,
            workingDirectory,
          ),
        },
        "listener_reflection_settings_send_failed",
        "listener_reflection_settings",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "get_reflection_settings_response",
          request_id: parsed.request_id,
          success: false,
          reflection_settings: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to load reflection settings",
        },
        "listener_reflection_settings_send_failed",
        "listener_reflection_settings",
      );
    }
    return true;
  }

  const { persistLocalProject, persistGlobal, normalizedScope } =
    resolveReflectionSettingsScope(parsed.scope);

  try {
    await persistReflectionSettingsForAgent(
      agentId,
      {
        trigger: parsed.settings.trigger,
        stepCount: parsed.settings.step_count,
      },
      {
        workingDirectory,
        persistLocalProject,
        persistGlobal,
      },
    );
    safeSocketSend(
      socket,
      {
        type: "set_reflection_settings_response",
        request_id: parsed.request_id,
        success: true,
        scope: normalizedScope,
        reflection_settings: toReflectionSettingsResponse(
          agentId,
          workingDirectory,
        ),
      },
      "listener_reflection_settings_send_failed",
      "listener_reflection_settings",
    );
    emitDeviceStatusUpdate(socket, listener, parsed.runtime);
  } catch (err) {
    safeSocketSend(
      socket,
      {
        type: "set_reflection_settings_response",
        request_id: parsed.request_id,
        success: false,
        scope: normalizedScope,
        reflection_settings: null,
        error:
          err instanceof Error
            ? err.message
            : "Failed to update reflection settings",
      },
      "listener_reflection_settings_send_failed",
      "listener_reflection_settings",
    );
  }
  return true;
}

/**
 * Wire channel ingress into the listener.
 *
 * Registers the ChannelRegistry's message handler and marks it as ready,
 * allowing buffered and future inbound channel messages to flow through
 * the queue pump.
 *
 * Called from the socket "open" handler — same pattern as startCronScheduler.
 * Uses closure-scoped socket/opts/processQueuedTurn.
 */
function wireChannelIngress(
  listener: ListenerRuntime,
  socket: WebSocket,
  opts: StartListenerOptions,
  processQueuedTurn: ProcessQueuedTurn,
): void {
  const registry = getChannelRegistry();
  if (!registry) return;

  registry.setMessageHandler((route, messageContent) => {
    // Follow the same pattern as cron/scheduler.ts:131-157
    const rawRuntime = getOrCreateConversationRuntime(
      listener,
      route.agentId,
      route.conversationId,
    );
    if (!rawRuntime) return;

    const conversationRuntime = ensureConversationQueueRuntime(
      listener,
      rawRuntime,
    );

    enqueueChannelTurn(conversationRuntime, route, messageContent);

    scheduleQueuePump(conversationRuntime, socket, opts, processQueuedTurn);
  });

  registry.setEventHandler((event) => {
    if (event.type === "pairings_updated") {
      emitChannelPairingsUpdated(
        socket,
        event.channelId as "telegram" | "slack",
      );
      emitChannelsUpdated(socket, event.channelId as "telegram" | "slack");
      return;
    }
    emitChannelTargetsUpdated(socket, event.channelId as "telegram" | "slack");
    emitChannelsUpdated(socket, event.channelId as "telegram" | "slack");
  });

  registry.setReady();
}

function enqueueChannelTurn(
  runtime: ConversationRuntime,
  route: {
    agentId: string;
    conversationId: string;
  },
  messageContent: MessageCreate["content"],
): { id: string } | null {
  const clientMessageId = `cm-channel-${crypto.randomUUID()}`;
  const enqueuedItem = runtime.queueRuntime.enqueue({
    kind: "message",
    source: "channel" as import("../../types/protocol").QueueItemSource,
    content: messageContent,
    clientMessageId,
    agentId: route.agentId,
    conversationId: route.conversationId,
  } as Omit<
    import("../../queue/queueRuntime").MessageQueueItem,
    "id" | "enqueuedAt"
  >);

  if (!enqueuedItem) {
    return null;
  }

  runtime.queuedMessagesByItemId.set(enqueuedItem.id, {
    type: "message",
    agentId: route.agentId,
    conversationId: route.conversationId,
    messages: [
      {
        role: "user",
        content: messageContent,
        client_message_id: clientMessageId,
      } satisfies MessageCreate & { client_message_id?: string },
    ],
  });

  return enqueuedItem;
}

export function ensureConversationQueueRuntime(
  listener: ListenerRuntime,
  runtime: ConversationRuntime,
): ConversationRuntime {
  if (runtime.queueRuntime) {
    return runtime;
  }
  runtime.queueRuntime = new QueueRuntime({
    callbacks: {
      onEnqueued: (item, queueLen) => {
        runtime.pendingTurns = queueLen;
        scheduleQueueEmit(listener, getQueueItemScope(item));
      },
      onDequeued: (batch) => {
        runtime.pendingTurns = batch.queueLenAfter;
        scheduleQueueEmit(listener, getQueueItemsScope(batch.items));
      },
      onBlocked: () => {
        scheduleQueueEmit(listener, {
          agent_id: runtime.agentId,
          conversation_id: runtime.conversationId,
        });
      },
      onCleared: (_reason, _clearedCount, items) => {
        runtime.pendingTurns = 0;
        scheduleQueueEmit(listener, getQueueItemsScope(items));
        evictConversationRuntimeIfIdle(runtime);
      },
      onDropped: (item, _reason, queueLen) => {
        runtime.pendingTurns = queueLen;
        runtime.queuedMessagesByItemId.delete(item.id);
        scheduleQueueEmit(listener, getQueueItemScope(item));
        evictConversationRuntimeIfIdle(runtime);
      },
    },
  });
  return runtime;
}

function getOrCreateScopedRuntime(
  listener: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): ConversationRuntime {
  return ensureConversationQueueRuntime(
    listener,
    getOrCreateConversationRuntime(listener, agentId, conversationId),
  );
}

/**
 * Fallback for unscoped task notifications (e.g., reflection/init spawned
 * outside turn processing). Picks the first ConversationRuntime that has a
 * QueueRuntime, or null if none exist.
 */
function findFallbackRuntime(
  listener: ListenerRuntime,
): ConversationRuntime | null {
  for (const cr of listener.conversationRuntimes.values()) {
    if (cr.queueRuntime) {
      return cr;
    }
  }
  return null;
}

function resolveRuntimeForApprovalRequest(
  listener: ListenerRuntime,
  requestId?: string | null,
): ConversationRuntime | null {
  if (!requestId) {
    return null;
  }
  const runtimeKey = listener.approvalRuntimeKeyByRequestId.get(requestId);
  if (!runtimeKey) {
    return null;
  }
  return listener.conversationRuntimes.get(runtimeKey) ?? null;
}

type ProcessQueuedTurn = (
  queuedTurn: IncomingMessage,
  dequeuedBatch: DequeuedBatch,
) => Promise<void>;

async function handleApprovalResponseInput(
  listener: ListenerRuntime,
  params: {
    runtime: {
      agent_id?: string | null;
      conversation_id?: string | null;
    };
    response: ApprovalResponseBody;
    socket: WebSocket;
    opts: {
      onStatusChange?: StartListenerOptions["onStatusChange"];
      connectionId?: string;
    };
    processQueuedTurn: ProcessQueuedTurn;
  },
  deps: {
    resolveRuntimeForApprovalRequest: (
      listener: ListenerRuntime,
      requestId?: string | null,
    ) => ConversationRuntime | null;
    resolvePendingApprovalResolver: (
      runtime: ConversationRuntime,
      response: ApprovalResponseBody,
    ) => boolean;
    getOrCreateScopedRuntime: (
      listener: ListenerRuntime,
      agentId?: string | null,
      conversationId?: string | null,
    ) => ConversationRuntime;
    resolveRecoveredApprovalResponse: (
      runtime: ConversationRuntime,
      socket: WebSocket,
      response: ApprovalResponseBody,
      processTurn: typeof handleIncomingMessage,
      opts?: {
        onStatusChange?: StartListenerOptions["onStatusChange"];
        connectionId?: string;
      },
    ) => Promise<boolean>;
    scheduleQueuePump: (
      runtime: ConversationRuntime,
      socket: WebSocket,
      opts: StartListenerOptions,
      processQueuedTurn: ProcessQueuedTurn,
    ) => void;
  } = {
    resolveRuntimeForApprovalRequest,
    resolvePendingApprovalResolver,
    getOrCreateScopedRuntime,
    resolveRecoveredApprovalResponse,
    scheduleQueuePump,
  },
): Promise<boolean> {
  const approvalRuntime = deps.resolveRuntimeForApprovalRequest(
    listener,
    params.response.request_id,
  );
  if (
    approvalRuntime &&
    deps.resolvePendingApprovalResolver(approvalRuntime, params.response)
  ) {
    deps.scheduleQueuePump(
      approvalRuntime,
      params.socket,
      params.opts as StartListenerOptions,
      params.processQueuedTurn,
    );
    return true;
  }

  const targetRuntime =
    approvalRuntime ??
    deps.getOrCreateScopedRuntime(
      listener,
      params.runtime.agent_id,
      params.runtime.conversation_id,
    );
  if (targetRuntime.cancelRequested && !targetRuntime.isProcessing) {
    targetRuntime.cancelRequested = false;
    deps.scheduleQueuePump(
      targetRuntime,
      params.socket,
      params.opts as StartListenerOptions,
      params.processQueuedTurn,
    );
    return false;
  }
  if (
    await deps.resolveRecoveredApprovalResponse(
      targetRuntime,
      params.socket,
      params.response,
      handleIncomingMessage,
      {
        onStatusChange: params.opts.onStatusChange,
        connectionId: params.opts.connectionId,
      },
    )
  ) {
    deps.scheduleQueuePump(
      targetRuntime,
      params.socket,
      params.opts as StartListenerOptions,
      params.processQueuedTurn,
    );
    return true;
  }

  return false;
}

async function handleChangeDeviceStateInput(
  listener: ListenerRuntime,
  params: {
    command: ChangeDeviceStateCommand;
    socket: WebSocket;
    opts: {
      onStatusChange?: StartListenerOptions["onStatusChange"];
      connectionId?: string;
    };
    processQueuedTurn: ProcessQueuedTurn;
  },
  deps: Partial<{
    getActiveRuntime: typeof getActiveRuntime;
    getOrCreateScopedRuntime: typeof getOrCreateScopedRuntime;
    getPendingControlRequestCount: typeof getPendingControlRequestCount;
    setLoopStatus: typeof setLoopStatus;
    handleModeChange: typeof handleModeChange;
    handleCwdChange: typeof handleCwdChange;
    emitDeviceStatusUpdate: typeof emitDeviceStatusUpdate;
    scheduleQueuePump: typeof scheduleQueuePump;
  }> = {},
): Promise<boolean> {
  const resolvedDeps = {
    getActiveRuntime,
    getOrCreateScopedRuntime,
    getPendingControlRequestCount,
    setLoopStatus,
    handleModeChange,
    handleCwdChange,
    emitDeviceStatusUpdate,
    scheduleQueuePump,
    ...deps,
  };

  if (
    listener !== resolvedDeps.getActiveRuntime() ||
    listener.intentionallyClosed
  ) {
    return false;
  }

  const scope = {
    agent_id:
      params.command.payload.agent_id ??
      params.command.runtime.agent_id ??
      undefined,
    conversation_id:
      params.command.payload.conversation_id ??
      params.command.runtime.conversation_id ??
      undefined,
  };
  const scopedRuntime = resolvedDeps.getOrCreateScopedRuntime(
    listener,
    scope.agent_id,
    scope.conversation_id,
  );
  const shouldTrackCommand =
    !scopedRuntime.isProcessing &&
    resolvedDeps.getPendingControlRequestCount(listener, scope) === 0;

  if (shouldTrackCommand) {
    resolvedDeps.setLoopStatus(scopedRuntime, "EXECUTING_COMMAND", scope);
  }

  try {
    if (params.command.payload.mode) {
      resolvedDeps.handleModeChange(
        { mode: params.command.payload.mode },
        params.socket,
        listener,
        scope,
      );
    }

    if (params.command.payload.cwd) {
      await resolvedDeps.handleCwdChange(
        {
          agentId: scope.agent_id ?? null,
          conversationId: scope.conversation_id ?? null,
          cwd: params.command.payload.cwd,
        },
        params.socket,
        scopedRuntime,
      );
    } else if (!params.command.payload.mode) {
      resolvedDeps.emitDeviceStatusUpdate(params.socket, listener, scope);
    }
  } finally {
    if (shouldTrackCommand) {
      resolvedDeps.setLoopStatus(scopedRuntime, "WAITING_ON_INPUT", scope);
      resolvedDeps.scheduleQueuePump(
        scopedRuntime,
        params.socket,
        params.opts as StartListenerOptions,
        params.processQueuedTurn,
      );
    }
  }

  return true;
}

async function handleAbortMessageInput(
  listener: ListenerRuntime,
  params: {
    command: AbortMessageCommand;
    socket: WebSocket;
    opts: {
      onStatusChange?: StartListenerOptions["onStatusChange"];
      connectionId?: string;
    };
    processQueuedTurn: ProcessQueuedTurn;
  },
  deps: Partial<{
    getActiveRuntime: typeof getActiveRuntime;
    getPendingControlRequestCount: typeof getPendingControlRequestCount;
    getPendingControlRequests: typeof getPendingControlRequests;
    getOrCreateScopedRuntime: typeof getOrCreateScopedRuntime;
    getRecoveredApprovalStateForScope: typeof getRecoveredApprovalStateForScope;
    stashRecoveredApprovalInterrupts: typeof stashRecoveredApprovalInterrupts;
    rejectPendingApprovalResolvers: typeof rejectPendingApprovalResolvers;
    setLoopStatus: typeof setLoopStatus;
    clearActiveRunState: typeof clearActiveRunState;
    emitRuntimeStateUpdates: typeof emitRuntimeStateUpdates;
    emitInterruptedStatusDelta: typeof emitInterruptedStatusDelta;
    scheduleQueuePump: typeof scheduleQueuePump;
    cancelConversation: (
      agentId: string,
      conversationId: string,
    ) => Promise<void>;
  }> = {},
): Promise<boolean> {
  const resolvedDeps = {
    getActiveRuntime,
    getPendingControlRequestCount,
    getPendingControlRequests,
    getOrCreateScopedRuntime,
    getRecoveredApprovalStateForScope,
    stashRecoveredApprovalInterrupts,
    rejectPendingApprovalResolvers,
    setLoopStatus,
    clearActiveRunState,
    emitRuntimeStateUpdates,
    emitInterruptedStatusDelta,
    scheduleQueuePump,
    cancelConversation: async (agentId: string, conversationId: string) => {
      const client = await getClient();
      const cancelId =
        conversationId === "default" || !conversationId
          ? agentId
          : conversationId;
      await client.conversations.cancel(cancelId);
    },
    ...deps,
  };

  if (
    listener !== resolvedDeps.getActiveRuntime() ||
    listener.intentionallyClosed
  ) {
    return false;
  }

  const scope = {
    agent_id: params.command.runtime.agent_id,
    conversation_id: params.command.runtime.conversation_id,
  };
  const hasPendingApprovals =
    resolvedDeps.getPendingControlRequestCount(listener, scope) > 0;
  const scopedRuntime = resolvedDeps.getOrCreateScopedRuntime(
    listener,
    scope.agent_id,
    scope.conversation_id,
  );
  const hasActiveTurn = scopedRuntime.isProcessing;

  if (!hasActiveTurn && !hasPendingApprovals) {
    return false;
  }

  const interruptedRunId = scopedRuntime.activeRunId;
  scopedRuntime.cancelRequested = true;
  const pendingRequestsSnapshot = hasPendingApprovals
    ? resolvedDeps.getPendingControlRequests(listener, scope)
    : [];

  if (
    scopedRuntime.activeExecutingToolCallIds.length > 0 &&
    (!scopedRuntime.pendingInterruptedResults ||
      scopedRuntime.pendingInterruptedResults.length === 0)
  ) {
    scopedRuntime.pendingInterruptedResults =
      scopedRuntime.activeExecutingToolCallIds.map((toolCallId) => ({
        type: "tool",
        tool_call_id: toolCallId,
        tool_return: INTERRUPTED_BY_USER,
        status: "error",
      }));
    scopedRuntime.pendingInterruptedContext = {
      agentId: scopedRuntime.agentId || "",
      conversationId: scopedRuntime.conversationId,
      continuationEpoch: scopedRuntime.continuationEpoch,
    };
    scopedRuntime.pendingInterruptedToolCallIds = [
      ...scopedRuntime.activeExecutingToolCallIds,
    ];
  }

  // Also set interrupt context for active turns without tracked tool IDs
  // (e.g., background Task tools that spawn subagents)
  if (
    hasActiveTurn &&
    scopedRuntime.activeExecutingToolCallIds.length === 0 &&
    !scopedRuntime.pendingInterruptedContext
  ) {
    scopedRuntime.pendingInterruptedContext = {
      agentId: scopedRuntime.agentId || "",
      conversationId: scopedRuntime.conversationId,
      continuationEpoch: scopedRuntime.continuationEpoch,
    };
    // Set empty results array so hasInterruptedCacheForScope can detect the interrupt
    scopedRuntime.pendingInterruptedResults = [];
  }

  if (
    scopedRuntime.activeAbortController &&
    !scopedRuntime.activeAbortController.signal.aborted
  ) {
    scopedRuntime.activeAbortController.abort();
  }

  const recoveredApprovalState = resolvedDeps.getRecoveredApprovalStateForScope(
    listener,
    scope,
  );
  if (recoveredApprovalState && !hasActiveTurn) {
    resolvedDeps.stashRecoveredApprovalInterrupts(
      scopedRuntime,
      recoveredApprovalState,
    );
  }

  if (hasPendingApprovals) {
    resolvedDeps.rejectPendingApprovalResolvers(
      scopedRuntime,
      "Cancelled by user",
    );
  }

  if (hasActiveTurn) {
    scopedRuntime.lastStopReason = "cancelled";
    scopedRuntime.isProcessing = false;
    resolvedDeps.clearActiveRunState(scopedRuntime);
    resolvedDeps.setLoopStatus(scopedRuntime, "WAITING_ON_INPUT", scope);
    resolvedDeps.emitRuntimeStateUpdates(scopedRuntime, scope);
    resolvedDeps.emitInterruptedStatusDelta(params.socket, scopedRuntime, {
      runId: interruptedRunId,
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
    });
  } else if (
    hasPendingApprovals &&
    (!scopedRuntime.pendingInterruptedResults ||
      scopedRuntime.pendingInterruptedResults.length === 0) &&
    pendingRequestsSnapshot.length > 0
  ) {
    // Populate interrupted cache to prevent stale approval recovery on sync
    scopedRuntime.pendingInterruptedResults = pendingRequestsSnapshot.map(
      (req) => ({
        type: "approval" as const,
        tool_call_id: req.request.tool_call_id,
        approve: false,
        reason: "User interrupted the stream",
      }),
    );
    scopedRuntime.pendingInterruptedContext = {
      agentId: scope.agent_id || "",
      conversationId: scope.conversation_id,
      continuationEpoch: scopedRuntime.continuationEpoch,
    };
    scopedRuntime.pendingInterruptedToolCallIds = null;
    resolvedDeps.emitInterruptedStatusDelta(params.socket, scopedRuntime, {
      runId: interruptedRunId,
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
    });
  }

  if (!hasActiveTurn) {
    scopedRuntime.cancelRequested = false;
  }

  const cancelConversationId = scopedRuntime.conversationId;
  const cancelAgentId = scopedRuntime.agentId;
  if (cancelAgentId) {
    void resolvedDeps
      .cancelConversation(cancelAgentId, cancelConversationId)
      .catch(() => {
        // Fire-and-forget
      });
  }

  resolvedDeps.scheduleQueuePump(
    scopedRuntime,
    params.socket,
    params.opts as StartListenerOptions,
    params.processQueuedTurn,
  );
  return true;
}

async function handleCwdChange(
  msg: ChangeCwdMessage,
  socket: WebSocket,
  runtime: ConversationRuntime,
): Promise<void> {
  const conversationId = normalizeConversationId(msg.conversationId);
  const agentId = normalizeCwdAgentId(msg.agentId);
  const currentWorkingDirectory = getConversationWorkingDirectory(
    runtime.listener,
    agentId,
    conversationId,
  );

  try {
    const requestedPath = msg.cwd?.trim();
    if (!requestedPath) {
      throw new Error("Working directory cannot be empty");
    }

    const resolvedPath = path.isAbsolute(requestedPath)
      ? requestedPath
      : path.resolve(currentWorkingDirectory, requestedPath);
    const normalizedPath = await realpath(resolvedPath);
    const stats = await stat(normalizedPath);
    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${normalizedPath}`);
    }

    setConversationWorkingDirectory(
      runtime.listener,
      agentId,
      conversationId,
      normalizedPath,
    );

    // Invalidate session-context only (not agent-info) so the agent gets
    // updated CWD/git info on the next turn.
    runtime.reminderState.hasSentSessionContext = false;
    runtime.reminderState.pendingSessionContextReason = "cwd_changed";

    // If the new cwd is outside the current file-index root, re-root the
    // index so file search covers the new workspace.  setIndexRoot()
    // triggers a non-blocking rebuild and does NOT mutate process.cwd(),
    // keeping concurrent conversations safe.
    const currentRoot = getIndexRoot();
    if (!normalizedPath.startsWith(currentRoot)) {
      setIndexRoot(normalizedPath);
    }

    emitDeviceStatusUpdate(socket, runtime, {
      agent_id: agentId,
      conversation_id: conversationId,
    });
  } catch (error) {
    emitLoopErrorNotice(socket, runtime, {
      message:
        error instanceof Error
          ? error.message
          : "Working directory change failed",
      stopReason: "error",
      isTerminal: false,
      agentId,
      conversationId,
      error,
    });
  }
}

function createRuntime(): ListenerRuntime {
  const bootWorkingDirectory = process.env.USER_CWD || process.cwd();
  return {
    socket: null,
    heartbeatInterval: null,
    reconnectTimeout: null,
    intentionallyClosed: false,
    hasSuccessfulConnection: false,
    everConnected: false,
    sessionId: `listen-${crypto.randomUUID()}`,
    eventSeqCounter: 0,
    lastStopReason: null,
    queueEmitScheduled: false,
    pendingQueueEmitScope: undefined,
    onWsEvent: undefined,
    reminderState: createSharedReminderState(),
    bootWorkingDirectory,
    workingDirectoryByConversation: loadPersistedCwdMap(),
    permissionModeByConversation: loadPersistedPermissionModeMap(),
    reminderStateByConversation: new Map(),
    contextTrackerByConversation: new Map(),
    systemPromptRecompileByConversation: new Map(),
    queuedSystemPromptRecompileByConversation: new Set(),
    connectionId: null,
    connectionName: null,
    conversationRuntimes: new Map(),
    approvalRuntimeKeyByRequestId: new Map(),
    memfsSyncedAgents: new Map(),
    lastEmittedStatus: null,
  };
}

function stopRuntime(
  runtime: ListenerRuntime,
  suppressCallbacks: boolean,
): void {
  setMessageQueueAdder(null); // Clear bridge for ALL stop paths
  runtime.intentionallyClosed = true;
  clearRuntimeTimers(runtime);
  for (const conversationRuntime of runtime.conversationRuntimes.values()) {
    rejectPendingApprovalResolvers(
      conversationRuntime,
      "Listener runtime stopped",
    );
    clearConversationRuntimeState(conversationRuntime);
    if (conversationRuntime.queueRuntime) {
      conversationRuntime.queuedMessagesByItemId.clear();
      conversationRuntime.queueRuntime.clear("shutdown");
    }
  }
  runtime.conversationRuntimes.clear();
  runtime.approvalRuntimeKeyByRequestId.clear();
  runtime.reminderStateByConversation.clear();
  runtime.contextTrackerByConversation.clear();
  runtime.systemPromptRecompileByConversation.clear();
  runtime.queuedSystemPromptRecompileByConversation.clear();

  if (!runtime.socket) {
    return;
  }

  const socket = runtime.socket;
  runtime.socket = null;

  // Stale runtimes being replaced should not emit callbacks/retries.
  if (suppressCallbacks) {
    socket.removeAllListeners();
  }

  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  ) {
    socket.close();
  }
}

/**
 * Start the listener WebSocket client with automatic retry.
 */
export async function startListenerClient(
  opts: StartListenerOptions,
): Promise<void> {
  // Replace any existing runtime without stale callback leakage.
  const existingRuntime = getActiveRuntime();
  if (existingRuntime) {
    stopRuntime(existingRuntime, true);
  }

  const runtime = createRuntime();
  runtime.onWsEvent = opts.onWsEvent;
  runtime.connectionId = opts.connectionId;
  runtime.connectionName = opts.connectionName;
  setActiveRuntime(runtime);
  telemetry.setSurface("websocket");
  telemetry.init();

  await connectWithRetry(runtime, opts);
}

/**
 * Connect to WebSocket with exponential backoff retry.
 */
async function connectWithRetry(
  runtime: ListenerRuntime,
  opts: StartListenerOptions,
  attempt: number = 0,
  startTime: number = Date.now(),
): Promise<void> {
  if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
    return;
  }

  const elapsedTime = Date.now() - startTime;

  if (attempt > 0) {
    if (elapsedTime >= MAX_RETRY_DURATION_MS) {
      // If we ever had a successful connection, try to re-register instead
      // of giving up. This keeps established sessions alive through transient
      // outages (e.g. Cloudflare 521, server deploys).
      if (runtime.everConnected && opts.onNeedsReregister) {
        opts.onNeedsReregister();
        return;
      }
      opts.onError(new Error("Failed to connect after 5 minutes of retrying"));
      return;
    }

    const delay = Math.min(
      INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1),
      MAX_RETRY_DELAY_MS,
    );
    const maxAttempts = Math.ceil(
      Math.log2(MAX_RETRY_DURATION_MS / INITIAL_RETRY_DELAY_MS),
    );

    opts.onRetrying?.(attempt, maxAttempts, delay, opts.connectionId);

    await new Promise<void>((resolve) => {
      runtime.reconnectTimeout = setTimeout(resolve, delay);
    });

    runtime.reconnectTimeout = null;
    if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
      return;
    }
  }

  clearRuntimeTimers(runtime);

  if (attempt === 0) {
    await loadTools();
  }

  const settings = await settingsManager.getSettingsWithSecureTokens();
  const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

  if (!apiKey) {
    throw new Error("Missing LETTA_API_KEY");
  }

  const url = new URL(opts.wsUrl);
  url.searchParams.set("deviceId", opts.deviceId);
  url.searchParams.set("connectionName", opts.connectionName);

  const socket = new WebSocket(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  // ── File watchers (keyed by absolute path) ─────────────────────────────
  // Managed by watch_file / unwatch_file commands from the web client.
  // Ref-counted so multiple windows watching the same file share one
  // fs.watch() handle — the watcher is only closed when the count hits 0.
  const fileWatchers = new Map<
    string,
    { watcher: import("node:fs").FSWatcher; refCount: number }
  >();
  // Debounce timers for fs.watch events — macOS/FSEvents can fire multiple
  // rapid events for a single save (especially atomic write-then-rename).
  const watchDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Tracks paths where unwatch_file arrived while the watch_file async task
  // was still in flight.  The task checks this set after its await and bails
  // out if present, preventing a leaked watcher.
  const cancelledWatches = new Set<string>();

  runtime.socket = socket;
  const processQueuedTurn: ProcessQueuedTurn = async (
    queuedTurn: IncomingMessage,
    dequeuedBatch: DequeuedBatch,
  ): Promise<void> => {
    const scopedRuntime = getOrCreateScopedRuntime(
      runtime,
      queuedTurn.agentId,
      queuedTurn.conversationId,
    );
    await handleIncomingMessage(
      queuedTurn,
      socket,
      scopedRuntime,
      opts.onStatusChange,
      opts.connectionId,
      dequeuedBatch.batchId,
    );
  };

  socket.on("open", () => {
    if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
      return;
    }

    safeEmitWsEvent("recv", "lifecycle", { type: "_ws_open" });
    runtime.hasSuccessfulConnection = true;
    runtime.everConnected = true;
    opts.onConnected(opts.connectionId);

    if (runtime.conversationRuntimes.size === 0) {
      // Don't emit device_status before the lookup store exists.
      // Without a conversation runtime, the scope resolves to
      // agent:__unknown__ which misses persisted CWD and permission
      // mode entries. The web's sync command will create a scoped
      // runtime and emit a properly-scoped device_status at that point.
      emitLoopStatusUpdate(socket, runtime);
    } else {
      for (const reminderState of runtime.reminderStateByConversation.values()) {
        // Reset bootstrap reminder state on (re)connect so session-context
        // and agent-info fire on the first turn of the new connection.
        // This is intentionally in the open handler, NOT the sync handler,
        // because the Desktop UMI controller sends sync every ~5 s and
        // resetting there would re-arm reminders on every periodic sync.
        resetSharedReminderState(reminderState);
      }
      for (const contextTracker of runtime.contextTrackerByConversation.values()) {
        resetContextHistory(contextTracker);
      }
      for (const conversationRuntime of runtime.conversationRuntimes.values()) {
        const scope = {
          agent_id: conversationRuntime.agentId,
          conversation_id: conversationRuntime.conversationId,
        };
        emitDeviceStatusUpdate(socket, conversationRuntime, scope);
        emitLoopStatusUpdate(socket, conversationRuntime, scope);
      }
    }

    // Subscribe to subagent state changes and emit snapshots over WS.
    // Store the unsubscribe function on the runtime for cleanup on close.
    runtime._unsubscribeSubagentState?.();
    runtime._unsubscribeSubagentState = subscribeToSubagentState(() => {
      if (runtime.conversationRuntimes.size === 0) {
        emitSubagentStateIfOpen(runtime);
        return;
      }

      for (const conversationRuntime of runtime.conversationRuntimes.values()) {
        emitSubagentStateIfOpen(runtime, {
          agent_id: conversationRuntime.agentId,
          conversation_id: conversationRuntime.conversationId,
        });
      }
    });

    // Subscribe to subagent stream events and forward as tagged stream_delta.
    // Events are raw JSON lines from the subagent's stdout (headless format):
    //   { type: "message", message_type: "tool_call_message", ...LettaStreamingResponse fields }
    // These are already MessageDelta-shaped (type:"message" + LettaStreamingResponse).
    runtime._unsubscribeSubagentStreamEvents?.();
    runtime._unsubscribeSubagentStreamEvents = subscribeToSubagentStreamEvents(
      (subagentId, event) => {
        if (socket.readyState !== WebSocket.OPEN) return;

        const subagent = getSubagents().find(
          (entry) => entry.id === subagentId,
        );
        if (subagent?.silent === true) {
          // Reflection/background "silent" subagents should not stream their
          // internal transcript into the parent conversation.
          return;
        }

        // The event has { type: "message", message_type, ...LettaStreamingResponse }
        // plus extra headless fields (session_id, uuid) that pass through harmlessly.
        emitStreamDelta(
          socket,
          runtime,
          event as unknown as import("../../types/protocol_v2").StreamDelta,
          subagent?.parentAgentId
            ? {
                agent_id: subagent.parentAgentId,
                conversation_id: subagent.parentConversationId ?? "default",
              }
            : undefined,
          subagentId,
        );
      },
    );

    // Register the message queue bridge to route task notifications into the
    // correct per-conversation QueueRuntime. This enables background Task
    // completions to reach the agent in listen mode.
    setMessageQueueAdder((queuedMessage) => {
      const targetRuntime =
        queuedMessage.agentId && queuedMessage.conversationId
          ? getOrCreateScopedRuntime(
              runtime,
              queuedMessage.agentId,
              queuedMessage.conversationId,
            )
          : findFallbackRuntime(runtime);

      if (!targetRuntime?.queueRuntime) {
        return; // No target — notification dropped
      }

      targetRuntime.queueRuntime.enqueue({
        kind: "task_notification",
        source: "task_notification",
        text: queuedMessage.text,
        agentId: queuedMessage.agentId ?? targetRuntime.agentId ?? undefined,
        conversationId:
          queuedMessage.conversationId ?? targetRuntime.conversationId,
      } as Omit<
        import("../../queue/queueRuntime").TaskNotificationQueueItem,
        "id" | "enqueuedAt"
      >);

      // Kick the queue pump so the notification can trigger a standalone turn
      // (see consumeQueuedTurn notification-aware path in queue.ts).
      scheduleQueuePump(targetRuntime, socket, opts, processQueuedTurn);
    });
    runtime.heartbeatInterval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        safeSocketSend(
          socket,
          { type: "ping" },
          "listener_ping_send_failed",
          "listener_heartbeat",
        );
      }
    }, 30000);

    // Start cron scheduler if tasks exist
    startCronScheduler(socket, opts, processQueuedTurn);

    // Wire channel ingress (if channels are active)
    wireChannelIngress(runtime, socket, opts, processQueuedTurn);
  });

  socket.on("message", async (data: WebSocket.RawData) => {
    const raw = data.toString();
    let parsedScope: ReturnType<typeof getParsedRuntimeScope> = null;

    try {
      const parsed = parseServerMessage(data);
      parsedScope = getParsedRuntimeScope(parsed);
      if (parsed) {
        safeEmitWsEvent("recv", "client", parsed);
      } else {
        // Log unparseable frames so protocol drift is visible in debug mode
        safeEmitWsEvent("recv", "lifecycle", {
          type: "_ws_unparseable",
          raw,
        });
      }
      if (isDebugEnabled()) {
        console.log(
          `[Listen] Received message: ${JSON.stringify(parsed, null, 2)}`,
        );
      }

      if (!parsed) {
        return;
      }

      if (parsed.type === "__invalid_input") {
        emitLoopErrorNotice(socket, runtime, {
          message: parsed.reason,
          stopReason: "error",
          isTerminal: false,
          agentId: parsed.runtime.agent_id,
          conversationId: parsed.runtime.conversation_id,
        });
        return;
      }

      if (parsed.type === "sync") {
        console.log(
          `[Listen V2] Received sync command for runtime=${parsed.runtime.agent_id}/${parsed.runtime.conversation_id}`,
        );
        if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
          console.log(`[Listen V2] Dropping sync: runtime mismatch or closed`);
          return;
        }
        await replaySyncStateForRuntime(runtime, socket, parsed.runtime);
        return;
      }

      if (parsed.type === "input") {
        console.log(
          `[Listen V2] Received input command, kind=${parsed.payload?.kind}`,
        );
        if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
          console.log(`[Listen V2] Dropping input: runtime mismatch or closed`);
          return;
        }

        if (parsed.payload.kind === "approval_response") {
          if (
            await handleApprovalResponseInput(runtime, {
              runtime: parsed.runtime,
              response: parsed.payload,
              socket,
              opts: {
                onStatusChange: opts.onStatusChange,
                connectionId: opts.connectionId,
              },
              processQueuedTurn,
            })
          ) {
            return;
          }
          return;
        }

        const inputPayload = parsed.payload;
        if (inputPayload.kind !== "create_message") {
          emitLoopErrorNotice(socket, runtime, {
            message: `Unsupported input payload kind: ${String((inputPayload as { kind?: unknown }).kind)}`,
            stopReason: "error",
            isTerminal: false,
            agentId: parsed.runtime.agent_id,
            conversationId: parsed.runtime.conversation_id,
          });
          return;
        }

        const incoming: IncomingMessage = {
          type: "message",
          agentId: parsed.runtime.agent_id,
          conversationId: parsed.runtime.conversation_id,
          messages: inputPayload.messages,
        };
        const hasApprovalPayload = incoming.messages.some(
          (payload): payload is ApprovalCreate =>
            "type" in payload && payload.type === "approval",
        );
        if (hasApprovalPayload) {
          emitLoopErrorNotice(socket, runtime, {
            message:
              "Protocol violation: approval payloads are not allowed in input.kind=create_message. Use input.kind=approval_response.",
            stopReason: "error",
            isTerminal: false,
            agentId: parsed.runtime.agent_id,
            conversationId: parsed.runtime.conversation_id,
          });
          return;
        }

        const scopedRuntime = getOrCreateScopedRuntime(
          runtime,
          incoming.agentId,
          incoming.conversationId,
        );

        if (shouldQueueInboundMessage(incoming)) {
          const firstUserPayload = incoming.messages.find(
            (
              payload,
            ): payload is MessageCreate & { client_message_id?: string } =>
              "content" in payload,
          );
          if (firstUserPayload) {
            const enqueuedItem = scopedRuntime.queueRuntime.enqueue({
              kind: "message",
              source: "user",
              content: firstUserPayload.content,
              clientMessageId:
                firstUserPayload.client_message_id ??
                `cm-submit-${crypto.randomUUID()}`,
              agentId: parsed.runtime.agent_id,
              conversationId: parsed.runtime.conversation_id || "default",
            } as Parameters<typeof scopedRuntime.queueRuntime.enqueue>[0]);
            if (enqueuedItem) {
              scopedRuntime.queuedMessagesByItemId.set(
                enqueuedItem.id,
                incoming,
              );
            }
          }
          scheduleQueuePump(scopedRuntime, socket, opts, processQueuedTurn);
          return;
        }

        scopedRuntime.messageQueue = scopedRuntime.messageQueue
          .then(async () => {
            if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
              return;
            }
            emitListenerStatus(runtime, opts.onStatusChange, opts.connectionId);
            await handleIncomingMessage(
              incoming,
              socket,
              scopedRuntime,
              opts.onStatusChange,
              opts.connectionId,
            );
            emitListenerStatus(runtime, opts.onStatusChange, opts.connectionId);
            scheduleQueuePump(scopedRuntime, socket, opts, processQueuedTurn);
          })
          .catch((error: unknown) => {
            trackListenerError(
              "listener_queued_input_failed",
              error,
              "listener_message_queue",
            );
            if (process.env.DEBUG) {
              console.error("[Listen] Error handling queued input:", error);
            }
            emitListenerStatus(runtime, opts.onStatusChange, opts.connectionId);
            scheduleQueuePump(scopedRuntime, socket, opts, processQueuedTurn);
          });
        return;
      }

      if (parsed.type === "change_device_state") {
        await handleChangeDeviceStateInput(runtime, {
          command: parsed,
          socket,
          opts: {
            onStatusChange: opts.onStatusChange,
            connectionId: opts.connectionId,
          },
          processQueuedTurn,
        });
        return;
      }

      if (parsed.type === "abort_message") {
        await handleAbortMessageInput(runtime, {
          command: parsed,
          socket,
          opts: {
            onStatusChange: opts.onStatusChange,
            connectionId: opts.connectionId,
          },
          processQueuedTurn,
        });
        return;
      }

      // ── File search (no runtime scope required) ────────────────────────
      if (isSearchFilesCommand(parsed)) {
        runDetachedListenerTask("search_files", async () => {
          try {
            // When the requested cwd lives outside the current index root
            // (e.g. a persisted CWD restored on startup that was never fed
            // through handleCwdChange), re-root the file index first so
            // the search covers the correct workspace.
            if (parsed.cwd) {
              const currentRoot = getIndexRoot();
              if (
                !parsed.cwd.startsWith(currentRoot + path.sep) &&
                parsed.cwd !== currentRoot
              ) {
                setIndexRoot(parsed.cwd);
              }
            }

            await ensureFileIndex();

            // Scope search to the conversation's cwd when provided.
            // The file index stores paths relative to the index root.
            let searchDir = ".";
            if (parsed.cwd) {
              const rel = path.relative(getIndexRoot(), parsed.cwd);
              // Only scope if cwd is within the index root (not "../" etc.)
              if (rel && !rel.startsWith("..") && rel !== "") {
                searchDir = rel;
              }
            }

            const files = searchFileIndex({
              searchDir,
              pattern: parsed.query,
              deep: true,
              maxResults: parsed.max_results ?? 5,
            });
            safeSocketSend(
              socket,
              {
                type: "search_files_response",
                request_id: parsed.request_id,
                files,
                success: true,
              },
              "listener_search_files_send_failed",
              "listener_search_files",
            );
          } catch (error) {
            trackListenerError(
              "listener_search_files_failed",
              error,
              "listener_file_search",
            );
            safeSocketSend(
              socket,
              {
                type: "search_files_response",
                request_id: parsed.request_id,
                files: [],
                success: false,
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to search files",
              },
              "listener_search_files_send_failed",
              "listener_search_files",
            );
          }
        });
        return;
      }

      // ── Directory listing (no runtime scope required) ──────────────────
      if (isListInDirectoryCommand(parsed)) {
        console.log(
          `[Listen] Received list_in_directory command: path=${parsed.path}`,
        );
        runDetachedListenerTask("list_in_directory", async () => {
          try {
            const { readdir } = await import("node:fs/promises");
            console.log(`[Listen] Reading directory: ${parsed.path}`);
            const entries = await readdir(parsed.path, { withFileTypes: true });
            console.log(
              `[Listen] Directory read success, ${entries.length} entries`,
            );

            // Filter out OS/VCS noise before sorting
            const IGNORED_NAMES = new Set([
              ".DS_Store",
              ".git",
              ".gitignore",
              "Thumbs.db",
            ]);
            const sortedEntries = entries
              .filter((e) => !IGNORED_NAMES.has(e.name))
              .sort((a, b) => a.name.localeCompare(b.name));

            const allFolders: string[] = [];
            const allFiles: string[] = [];
            for (const e of sortedEntries) {
              if (e.isDirectory()) {
                allFolders.push(e.name);
              } else if (parsed.include_files) {
                allFiles.push(e.name);
              }
            }

            const total = allFolders.length + allFiles.length;
            const offset = parsed.offset ?? 0;
            const limit = parsed.limit ?? total;

            // Paginate over the combined [folders, files] list
            const combined = [...allFolders, ...allFiles];
            const page = combined.slice(offset, offset + limit);
            const folders = page.filter((name) => allFolders.includes(name));
            const files = page.filter((name) => allFiles.includes(name));

            const response: Record<string, unknown> = {
              type: "list_in_directory_response",
              path: parsed.path,
              folders,
              hasMore: offset + limit < total,
              total,
              success: true,
              ...(parsed.request_id ? { request_id: parsed.request_id } : {}),
            };
            if (parsed.include_files) {
              response.files = files;
            }
            console.log(
              `[Listen] Sending list_in_directory_response: ${folders.length} folders, ${files?.length ?? 0} files`,
            );
            safeSocketSend(
              socket,
              response,
              "listener_list_directory_send_failed",
              "listener_list_in_directory",
            );
          } catch (err) {
            trackListenerError(
              "listener_list_directory_failed",
              err,
              "listener_file_browser",
            );
            console.error(
              `[Listen] list_in_directory error: ${err instanceof Error ? err.message : "Unknown error"}`,
            );
            safeSocketSend(
              socket,
              {
                type: "list_in_directory_response",
                path: parsed.path,
                folders: [],
                hasMore: false,
                success: false,
                error:
                  err instanceof Error
                    ? err.message
                    : "Failed to list directory",
                ...(parsed.request_id ? { request_id: parsed.request_id } : {}),
              },
              "listener_list_directory_send_failed",
              "listener_list_in_directory",
            );
          }
        });
        return;
      }

      // ── File reading (no runtime scope required) ─────────────────────
      if (isReadFileCommand(parsed)) {
        console.log(
          `[Listen] Received read_file command: path=${parsed.path}, request_id=${parsed.request_id}`,
        );
        runDetachedListenerTask("read_file", async () => {
          try {
            const { readFile } = await import("node:fs/promises");
            const content = await readFile(parsed.path, "utf-8");
            console.log(
              `[Listen] read_file success: ${parsed.path} (${content.length} bytes)`,
            );
            safeSocketSend(
              socket,
              {
                type: "read_file_response",
                request_id: parsed.request_id,
                path: parsed.path,
                content,
                success: true,
              },
              "listener_read_file_send_failed",
              "listener_read_file",
            );
          } catch (err) {
            trackListenerError(
              "listener_read_file_failed",
              err,
              "listener_file_read",
            );
            console.error(
              `[Listen] read_file error: ${err instanceof Error ? err.message : "Unknown error"}`,
            );
            safeSocketSend(
              socket,
              {
                type: "read_file_response",
                request_id: parsed.request_id,
                path: parsed.path,
                content: null,
                success: false,
                error:
                  err instanceof Error ? err.message : "Failed to read file",
              },
              "listener_read_file_send_failed",
              "listener_read_file",
            );
          }
        });
        return;
      }

      // ── File writing (no runtime scope required) ──────────────────────
      if (isWriteFileCommand(parsed)) {
        console.log(
          `[Listen] Received write_file command: path=${parsed.path}, request_id=${parsed.request_id}`,
        );
        runDetachedListenerTask("write_file", async () => {
          try {
            const { edit } = await import("../../tools/impl/Edit");
            const { write } = await import("../../tools/impl/Write");
            const { readFile } = await import("node:fs/promises");

            // Read current content so we can use edit for an atomic
            // read-modify-write that goes through the same code path as
            // the agent's Edit tool (CRLF normalisation, rich errors, etc.).
            let currentContent: string | null = null;
            try {
              currentContent = await readFile(parsed.path, "utf-8");
            } catch (readErr) {
              const e = readErr as NodeJS.ErrnoException;
              if (e.code !== "ENOENT") throw readErr;
              // ENOENT — new file, fall through to write below
            }

            if (currentContent === null) {
              // New file — use write so directories are created as needed.
              await write({ file_path: parsed.path, content: parsed.content });
            } else {
              // Existing file — use edit for a full-content replacement.
              // Normalise line endings before comparing to avoid a spurious
              // "no changes" error when the only difference is CRLF vs LF.
              const normalizedCurrent = currentContent.replace(/\r\n/g, "\n");
              const normalizedNew = parsed.content.replace(/\r\n/g, "\n");
              if (normalizedCurrent !== normalizedNew) {
                await edit({
                  file_path: parsed.path,
                  old_string: currentContent,
                  new_string: parsed.content,
                });
              }
              // else: content unchanged — no-op, still respond success below
            }

            console.log(
              `[Listen] write_file success: ${parsed.path} (${parsed.content.length} bytes)`,
            );
            safeSocketSend(
              socket,
              {
                type: "write_file_response",
                request_id: parsed.request_id,
                path: parsed.path,
                success: true,
              },
              "listener_write_file_send_failed",
              "listener_write_file",
            );
          } catch (err) {
            console.error(
              `[Listen] write_file error: ${err instanceof Error ? err.message : "Unknown error"}`,
            );
            safeSocketSend(
              socket,
              {
                type: "write_file_response",
                request_id: parsed.request_id,
                path: parsed.path,
                success: false,
                error:
                  err instanceof Error ? err.message : "Failed to write file",
              },
              "listener_write_file_send_failed",
              "listener_write_file",
            );
          }
        });
        return;
      }

      // ── File watching (no runtime scope required) ─────────────────────
      if (isWatchFileCommand(parsed)) {
        runDetachedListenerTask("watch_file", async () => {
          const existing = fileWatchers.get(parsed.path);
          if (existing) {
            existing.refCount++;
            return;
          }
          try {
            const { watch } = await import("node:fs");
            const { stat } = await import("node:fs/promises");
            // Check if unwatch arrived while we were awaiting imports
            if (cancelledWatches.delete(parsed.path)) return;
            const watcher = watch(
              parsed.path,
              { persistent: false },
              (eventType) => {
                // Handle both "change" (normal write) and "rename" (atomic
                // write-then-rename, common on Linux).  We stat() the original
                // path — if it still exists the content was updated; if not
                // the file was deleted and the catch handler cleans up.
                if (eventType !== "change" && eventType !== "rename") return;
                // Debounce: macOS/FSEvents can fire multiple rapid events
                // for a single save.  Collapse into one file_changed push.
                const existing = watchDebounceTimers.get(parsed.path);
                if (existing) clearTimeout(existing);
                watchDebounceTimers.set(
                  parsed.path,
                  setTimeout(() => {
                    watchDebounceTimers.delete(parsed.path);
                    stat(parsed.path)
                      .then((s) => {
                        safeSocketSend(
                          socket,
                          {
                            type: "file_changed",
                            path: parsed.path,
                            lastModified: Math.round(s.mtimeMs),
                          },
                          "listener_file_changed_send_failed",
                          "listener_watch_file",
                        );
                      })
                      .catch(() => {
                        // File deleted — stop watching
                        const entry = fileWatchers.get(parsed.path);
                        if (entry) {
                          entry.watcher.close();
                          fileWatchers.delete(parsed.path);
                        }
                      });
                  }, 150),
                );
              },
            );
            watcher.on("error", () => {
              watcher.close();
              fileWatchers.delete(parsed.path);
            });
            fileWatchers.set(parsed.path, { watcher, refCount: 1 });
          } catch {
            // fs.watch not supported or path invalid — silently ignore
          }
        });
        return;
      }

      if (isUnwatchFileCommand(parsed)) {
        const entry = fileWatchers.get(parsed.path);
        if (entry) {
          entry.refCount--;
          if (entry.refCount <= 0) {
            entry.watcher.close();
            fileWatchers.delete(parsed.path);
          }
        } else {
          // watch_file async task may still be in flight — mark for cancel
          cancelledWatches.add(parsed.path);
        }
        const timer = watchDebounceTimers.get(parsed.path);
        if (timer) {
          clearTimeout(timer);
          watchDebounceTimers.delete(parsed.path);
        }
        return;
      }

      // ── File editing (no runtime scope required) ─────────────────────
      if (isEditFileCommand(parsed)) {
        console.log(
          `[Listen] Received edit_file command: file_path=${parsed.file_path}, request_id=${parsed.request_id}`,
        );
        runDetachedListenerTask("edit_file", async () => {
          try {
            const { edit } = await import("../../tools/impl/Edit");
            console.log(
              `[Listen] Executing edit: old_string="${parsed.old_string.slice(0, 50)}${parsed.old_string.length > 50 ? "..." : ""}"`,
            );
            const result = await edit({
              file_path: parsed.file_path,
              old_string: parsed.old_string,
              new_string: parsed.new_string,
              replace_all: parsed.replace_all,
              expected_replacements: parsed.expected_replacements,
            });
            console.log(
              `[Listen] edit_file success: ${result.replacements} replacement(s) at line ${result.startLine}`,
            );
            safeSocketSend(
              socket,
              {
                type: "edit_file_response",
                request_id: parsed.request_id,
                file_path: parsed.file_path,
                message: result.message,
                replacements: result.replacements,
                start_line: result.startLine,
                success: true,
              },
              "listener_edit_file_send_failed",
              "listener_edit_file",
            );
          } catch (err) {
            trackListenerError(
              "listener_edit_file_failed",
              err,
              "listener_file_edit",
            );
            console.error(
              `[Listen] edit_file error: ${err instanceof Error ? err.message : "Unknown error"}`,
            );
            safeSocketSend(
              socket,
              {
                type: "edit_file_response",
                request_id: parsed.request_id,
                file_path: parsed.file_path,
                message: null,
                replacements: 0,
                success: false,
                error:
                  err instanceof Error ? err.message : "Failed to edit file",
              },
              "listener_edit_file_send_failed",
              "listener_edit_file",
            );
          }
        });
        return;
      }

      // ── Memory index (no runtime scope required) ─────────────────────
      if (isListMemoryCommand(parsed)) {
        runDetachedListenerTask("list_memory", async () => {
          try {
            const { getMemoryFilesystemRoot } = await import(
              "../../agent/memoryFilesystem"
            );
            const { scanMemoryFilesystem, getFileNodes, readFileContent } =
              await import("../../agent/memoryScanner");
            const { parseFrontmatter } = await import(
              "../../utils/frontmatter"
            );

            const { existsSync } = await import("node:fs");
            const { join, posix } = await import("node:path");

            const memoryRoot = getMemoryFilesystemRoot(parsed.agent_id);

            // If the memory directory doesn't have a git repo, memfs
            // hasn't been initialized — tell the UI so it can show the
            // enable button instead of an empty file list.
            const memfsInitialized = existsSync(join(memoryRoot, ".git"));

            if (!memfsInitialized) {
              safeSocketSend(
                socket,
                {
                  type: "list_memory_response",
                  request_id: parsed.request_id,
                  entries: [],
                  done: true,
                  total: 0,
                  success: true,
                  memfs_initialized: false,
                },
                "listener_list_memory_send_failed",
                "listener_list_memory",
              );
              return;
            }

            const treeNodes = scanMemoryFilesystem(memoryRoot);
            const fileNodes = getFileNodes(treeNodes).filter((n) =>
              n.name.endsWith(".md"),
            );
            const includeReferences = parsed.include_references === true;

            const allPaths = new Set(
              fileNodes.map((node) => node.relativePath),
            );

            const normalizeMemoryReference = (
              rawReference: string,
              sourcePath: string,
            ): string | null => {
              let target = rawReference.trim();
              if (!target) {
                return null;
              }

              if (
                target.startsWith("http://") ||
                target.startsWith("https://") ||
                target.startsWith("mailto:")
              ) {
                return null;
              }

              target = target.replace(/^<|>$/g, "");
              target = target.split("#")[0] ?? "";
              target = target.split("?")[0] ?? "";
              target = target.trim().replace(/\\/g, "/");

              if (!target || target.startsWith("#")) {
                return null;
              }

              if (target.includes("|")) {
                target = target.split("|")[0] ?? "";
              }

              if (!target) {
                return null;
              }

              const sourceDir = posix.dirname(sourcePath.replace(/\\/g, "/"));
              const candidate =
                target.startsWith("./") || target.startsWith("../")
                  ? posix.normalize(posix.join(sourceDir, target))
                  : posix.normalize(
                      target.startsWith("/") ? target.slice(1) : target,
                    );

              if (
                !candidate ||
                candidate.startsWith("../") ||
                candidate === "." ||
                candidate === ".."
              ) {
                return null;
              }

              const withExtension = candidate.endsWith(".md")
                ? candidate
                : `${candidate}.md`;

              const candidates = new Set<string>([withExtension]);

              const isExplicitRelative =
                target.startsWith("./") || target.startsWith("../");
              if (
                !isExplicitRelative &&
                !target.startsWith("/") &&
                sourceDir &&
                sourceDir !== "."
              ) {
                candidates.add(
                  posix.normalize(posix.join(sourceDir, withExtension)),
                );
              }

              if (!withExtension.startsWith("system/")) {
                candidates.add(posix.normalize(`system/${withExtension}`));
              }

              for (const resolved of candidates) {
                if (allPaths.has(resolved)) {
                  return resolved;
                }
              }

              return null;
            };

            const extractMemoryReferences = (
              body: string,
              sourcePath: string,
            ): string[] => {
              if (!body.includes("[[")) {
                return [];
              }

              const refs = new Set<string>();

              for (const wikiMatch of body.matchAll(WIKI_LINK_REGEX)) {
                const rawTarget = wikiMatch[1];
                if (!rawTarget) continue;
                const normalized = normalizeMemoryReference(
                  rawTarget,
                  sourcePath,
                );
                if (normalized && normalized !== sourcePath) {
                  refs.add(normalized);
                }
              }

              return [...refs];
            };

            const CHUNK_SIZE = 5;
            const total = fileNodes.length;

            for (let i = 0; i < total; i += CHUNK_SIZE) {
              const chunk = fileNodes.slice(i, i + CHUNK_SIZE);
              const entries = chunk.map((node) => {
                const raw = readFileContent(node.fullPath);
                const { frontmatter, body } = parseFrontmatter(raw);
                const desc = frontmatter.description;
                return {
                  relative_path: node.relativePath,
                  is_system:
                    node.relativePath.startsWith("system/") ||
                    node.relativePath.startsWith("system\\"),
                  description: typeof desc === "string" ? desc : null,
                  content: body,
                  size: body.length,
                  ...(includeReferences
                    ? {
                        references: extractMemoryReferences(
                          body,
                          node.relativePath,
                        ),
                      }
                    : {}),
                };
              });

              const done = i + CHUNK_SIZE >= total;
              const sent = safeSocketSend(
                socket,
                {
                  type: "list_memory_response",
                  request_id: parsed.request_id,
                  entries,
                  done,
                  total,
                  success: true,
                  memfs_initialized: true,
                },
                "listener_list_memory_send_failed",
                "listener_list_memory",
              );
              if (!sent) {
                return;
              }
            }

            // Edge case: no files at all (repo exists but empty)
            if (total === 0) {
              safeSocketSend(
                socket,
                {
                  type: "list_memory_response",
                  request_id: parsed.request_id,
                  entries: [],
                  done: true,
                  total: 0,
                  success: true,
                  memfs_initialized: true,
                },
                "listener_list_memory_send_failed",
                "listener_list_memory",
              );
            }
          } catch (err) {
            trackListenerError(
              "listener_list_memory_failed",
              err,
              "listener_memory_browser",
            );
            safeSocketSend(
              socket,
              {
                type: "list_memory_response",
                request_id: parsed.request_id,
                entries: [],
                done: true,
                total: 0,
                success: false,
                error:
                  err instanceof Error ? err.message : "Failed to list memory",
              },
              "listener_list_memory_send_failed",
              "listener_list_memory",
            );
          }
        });
        return;
      }

      // ── Enable memfs command ────────────────────────────────────────────
      if (isEnableMemfsCommand(parsed)) {
        runDetachedListenerTask("enable_memfs", async () => {
          try {
            const { applyMemfsFlags } = await import(
              "../../agent/memoryFilesystem"
            );
            const result = await applyMemfsFlags(parsed.agent_id, true, false);
            safeSocketSend(
              socket,
              {
                type: "enable_memfs_response",
                request_id: parsed.request_id,
                success: true,
                memory_directory: result.memoryDir,
              },
              "listener_enable_memfs_send_failed",
              "listener_enable_memfs",
            );
            // Push memory_updated so the UI auto-refreshes its file list
            safeSocketSend(
              socket,
              {
                type: "memory_updated",
                affected_paths: ["*"],
                timestamp: Date.now(),
              },
              "listener_enable_memfs_send_failed",
              "listener_enable_memfs",
            );
          } catch (err) {
            trackListenerError(
              "listener_enable_memfs_failed",
              err,
              "listener_memfs_enable",
            );
            safeSocketSend(
              socket,
              {
                type: "enable_memfs_response",
                request_id: parsed.request_id,
                success: false,
                error:
                  err instanceof Error ? err.message : "Failed to enable memfs",
              },
              "listener_enable_memfs_send_failed",
              "listener_enable_memfs",
            );
          }
        });
        return;
      }

      // ── Model catalog command (no runtime scope required) ───────────────
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
                  error instanceof Error
                    ? error.message
                    : "Failed to list models",
              },
              "listener_list_models_send_failed",
              "listener_list_models",
            );
          }
        });
        return;
      }

      // ── Model update command (runtime scoped) ────────────────────────────
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
                error instanceof Error
                  ? error.message
                  : "Failed to update model",
            };
            safeSocketSend(
              socket,
              failure,
              "listener_update_model_send_failed",
              "listener_update_model",
            );
          }
        });
        return;
      }

      // ── Memory history (git log for a specific file) ─────────────────
      if (isMemoryHistoryCommand(parsed)) {
        runDetachedListenerTask("memory_history", async () => {
          const { getMemoryFilesystemRoot } = await import(
            "../../agent/memoryFilesystem"
          );
          const { execFile: execFileCb } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFileCb);

          const memoryRoot = getMemoryFilesystemRoot(parsed.agent_id);
          const limit = parsed.limit ?? 50;

          const { stdout } = await execFileAsync(
            "git",
            [
              "log",
              `--max-count=${limit}`,
              "--format=%H|%s|%aI|%an",
              "--",
              parsed.file_path,
            ],
            { cwd: memoryRoot, timeout: 10000 },
          );

          const commits = stdout
            .trim()
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => {
              const [sha, message, timestamp, authorName] = line.split("|");
              return {
                sha: sha ?? "",
                message: message ?? "",
                timestamp: timestamp ?? "",
                author_name: authorName ?? null,
              };
            });

          safeSocketSend(
            socket,
            {
              type: "memory_history_response",
              request_id: parsed.request_id,
              file_path: parsed.file_path,
              commits,
              success: true,
            },
            "listener_memory_history_send_failed",
            "listener_memory_history",
          );
        });
        return;
      }

      // ── Memory file at ref (git show for content at a commit) ────────
      if (isMemoryFileAtRefCommand(parsed)) {
        runDetachedListenerTask("memory_file_at_ref", async () => {
          const { getMemoryFilesystemRoot } = await import(
            "../../agent/memoryFilesystem"
          );
          const { execFile: execFileCb } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFileCb);

          const memoryRoot = getMemoryFilesystemRoot(parsed.agent_id);

          try {
            const { stdout } = await execFileAsync(
              "git",
              ["show", `${parsed.ref}:${parsed.file_path}`],
              { cwd: memoryRoot, timeout: 10000 },
            );

            safeSocketSend(
              socket,
              {
                type: "memory_file_at_ref_response",
                request_id: parsed.request_id,
                file_path: parsed.file_path,
                ref: parsed.ref,
                content: stdout,
                success: true,
              },
              "listener_memory_file_at_ref_send_failed",
              "listener_memory_file_at_ref",
            );
          } catch (err) {
            safeSocketSend(
              socket,
              {
                type: "memory_file_at_ref_response",
                request_id: parsed.request_id,
                file_path: parsed.file_path,
                ref: parsed.ref,
                content: null,
                success: false,
                error:
                  err instanceof Error
                    ? err.message
                    : "Failed to read file at ref",
              },
              "listener_memory_file_at_ref_send_failed",
              "listener_memory_file_at_ref",
            );
          }
        });
        return;
      }

      // ── Cron CRUD commands (no runtime scope required) ────────────────
      if (
        isCronListCommand(parsed) ||
        isCronAddCommand(parsed) ||
        isCronGetCommand(parsed) ||
        isCronDeleteCommand(parsed) ||
        isCronDeleteAllCommand(parsed)
      ) {
        runDetachedListenerTask("cron_command", async () => {
          await handleCronCommand(parsed, socket);
        });
        return;
      }

      // ── Channels management commands (device/live management) ─────────
      if (isDetachedChannelsCommand(parsed)) {
        runDetachedListenerTask("channels_command", async () => {
          await handleChannelsProtocolCommand(
            parsed,
            socket,
            runtime,
            opts,
            processQueuedTurn,
          );
        });
        return;
      }

      // ── Skill enable/disable commands (no runtime scope required) ─────
      if (isSkillEnableCommand(parsed) || isSkillDisableCommand(parsed)) {
        runDetachedListenerTask("skill_command", async () => {
          await handleSkillCommand(parsed, socket);
        });
        return;
      }

      // ── Agent management commands (no runtime scope required) ─────────
      if (isCreateAgentCommand(parsed)) {
        runDetachedListenerTask("create_agent_command", async () => {
          await handleCreateAgentCommand(parsed, socket);
        });
        return;
      }

      if (
        isGetReflectionSettingsCommand(parsed) ||
        isSetReflectionSettingsCommand(parsed)
      ) {
        runDetachedListenerTask("reflection_settings_command", async () => {
          await handleReflectionSettingsCommand(parsed, socket, runtime);
        });
        return;
      }

      // ── Slash commands (execute_command) ────────────────────────────────
      if (isExecuteCommandCommand(parsed)) {
        // Slash commands need a scoped runtime for the conversation context
        const scopedRuntime = getOrCreateScopedRuntime(
          runtime,
          parsed.runtime.agent_id,
          parsed.runtime.conversation_id,
        );
        runDetachedListenerTask("execute_command", async () => {
          await handleExecuteCommand(parsed, socket, scopedRuntime, {
            onStatusChange: opts.onStatusChange,
            connectionId: opts.connectionId,
          });
        });
        return;
      }

      // ── Git branch commands (no runtime scope required) ────────────────
      if (isSearchBranchesCommand(parsed)) {
        runDetachedListenerTask("search_branches", async () => {
          try {
            const cwd = parsed.cwd ?? runtime.bootWorkingDirectory;
            const maxResults = parsed.max_results ?? 20;
            const execFileAsync = promisify(execFile);

            // Get local + remote branches with format
            const { stdout } = await execFileAsync(
              "git",
              ["branch", "-a", "--format=%(refname:short)\t%(HEAD)"],
              {
                cwd,
                encoding: "utf-8",
                timeout: 5000,
              },
            );

            const query = parsed.query.toLowerCase();
            const branches = stdout
              .split("\n")
              .filter((line) => line.trim().length > 0)
              .map((line) => {
                const parts = line.split("\t");
                const trimmedName = (parts[0] ?? "").trim();
                const isRemote = trimmedName.startsWith("origin/");
                return {
                  name: trimmedName,
                  is_current: parts[1]?.trim() === "*",
                  is_remote: isRemote,
                };
              })
              .filter(
                (b) =>
                  query.length === 0 || b.name.toLowerCase().includes(query),
              )
              .slice(0, maxResults);

            safeSocketSend(
              socket,
              {
                type: "search_branches_response",
                request_id: parsed.request_id,
                branches,
                success: true,
              },
              "listener_search_branches_send_failed",
              "listener_search_branches",
            );
          } catch (error) {
            safeSocketSend(
              socket,
              {
                type: "search_branches_response",
                request_id: parsed.request_id,
                branches: [],
                success: false,
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to search branches",
              },
              "listener_search_branches_send_failed",
              "listener_search_branches",
            );
          }
        });
        return;
      }

      if (isCheckoutBranchCommand(parsed)) {
        runDetachedListenerTask("checkout_branch", async () => {
          try {
            const cwd = parsed.cwd ?? runtime.bootWorkingDirectory;
            const execFileAsync = promisify(execFile);

            const args = parsed.create
              ? ["checkout", "-b", parsed.branch]
              : ["checkout", parsed.branch];

            await execFileAsync("git", args, {
              cwd,
              encoding: "utf-8",
              timeout: 10000,
            });

            // Re-read the current branch after checkout to confirm
            const gitCtx = getGitContext(cwd);

            safeSocketSend(
              socket,
              {
                type: "checkout_branch_response",
                request_id: parsed.request_id,
                branch: gitCtx?.branch ?? parsed.branch,
                success: true,
              },
              "listener_checkout_branch_send_failed",
              "listener_checkout_branch",
            );

            // Emit updated device status so UIs pick up the new branch
            emitDeviceStatusUpdate(socket, runtime);
          } catch (error) {
            safeSocketSend(
              socket,
              {
                type: "checkout_branch_response",
                request_id: parsed.request_id,
                branch: parsed.branch,
                success: false,
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to checkout branch",
              },
              "listener_checkout_branch_send_failed",
              "listener_checkout_branch",
            );
          }
        });
        return;
      }

      // ── Terminal commands (no runtime scope required) ──────────────────
      if (parsed.type === "terminal_spawn") {
        handleTerminalSpawn(
          parsed,
          socket,
          parsed.cwd ?? runtime.bootWorkingDirectory,
        );
        return;
      }

      if (parsed.type === "terminal_input") {
        handleTerminalInput(parsed);
        return;
      }

      if (parsed.type === "terminal_resize") {
        handleTerminalResize(parsed);
        return;
      }

      if (parsed.type === "terminal_kill") {
        handleTerminalKill(parsed);
        return;
      }
    } catch (error) {
      trackListenerError(
        "listener_message_handler_failed",
        error,
        "listener_message_handler",
      );
      if (isDebugEnabled()) {
        console.error("[Listen] Unhandled message handler error:", error);
      }

      if (!parsedScope) {
        return;
      }

      emitLoopErrorNotice(socket, runtime, {
        message:
          error instanceof Error
            ? error.message
            : "Failed to process listener message",
        stopReason: "error",
        isTerminal: false,
        agentId: parsedScope.agent_id,
        conversationId: parsedScope.conversation_id,
        error,
      });
    }
  });

  socket.on("close", (code: number, reason: Buffer) => {
    if (runtime !== getActiveRuntime()) {
      return;
    }

    safeEmitWsEvent("recv", "lifecycle", {
      type: "_ws_close",
      code,
      reason: reason.toString(),
    });

    // Close all file watchers on disconnect
    for (const { watcher } of fileWatchers.values()) {
      watcher.close();
    }
    fileWatchers.clear();
    for (const timer of watchDebounceTimers.values()) {
      clearTimeout(timer);
    }
    watchDebounceTimers.clear();
    cancelledWatches.clear();

    // Stop cron scheduler on disconnect
    stopCronScheduler();

    // Pause channel delivery on disconnect (adapters keep polling, messages buffer).
    // On reconnect, wireChannelIngress() re-registers the handler and calls setReady().
    const channelRegistry = getChannelRegistry();
    if (channelRegistry) {
      channelRegistry.pause();
    }

    // Clear the bridge before queue clearing to prevent a race where a task
    // completion enqueues into a shutting-down runtime.
    setMessageQueueAdder(null);

    // Single authoritative queue clear for all close paths
    // (intentional and unintentional). Must fire before early returns.
    for (const conversationRuntime of runtime.conversationRuntimes.values()) {
      conversationRuntime.queuedMessagesByItemId.clear();
      if (conversationRuntime.queueRuntime) {
        conversationRuntime.queueRuntime.clear("shutdown");
      }
    }

    if (isDebugEnabled()) {
      console.log(
        `[Listen] WebSocket disconnected (code: ${code}, reason: ${reason.toString()})`,
      );
    }

    clearRuntimeTimers(runtime);
    killAllTerminals();
    runtime._unsubscribeSubagentState?.();
    runtime._unsubscribeSubagentState = undefined;
    runtime._unsubscribeSubagentStreamEvents?.();
    runtime._unsubscribeSubagentStreamEvents = undefined;
    runtime.socket = null;
    for (const conversationRuntime of runtime.conversationRuntimes.values()) {
      rejectPendingApprovalResolvers(
        conversationRuntime,
        "WebSocket disconnected",
      );
      clearConversationRuntimeState(conversationRuntime);
      evictConversationRuntimeIfIdle(conversationRuntime);
    }

    if (runtime.intentionallyClosed) {
      opts.onDisconnected();
      return;
    }

    // 1008: Environment not found - need to re-register
    if (code === 1008) {
      if (isDebugEnabled()) {
        console.log("[Listen] Environment not found, re-registering...");
      }
      // Stop retry loop and signal that we need to re-register
      if (opts.onNeedsReregister) {
        opts.onNeedsReregister();
      } else {
        opts.onDisconnected();
      }
      return;
    }

    // If we had connected before, restart backoff from zero for this outage window.
    const nextAttempt = runtime.hasSuccessfulConnection ? 0 : attempt + 1;
    const nextStartTime = runtime.hasSuccessfulConnection
      ? Date.now()
      : startTime;
    runtime.hasSuccessfulConnection = false;

    connectWithRetry(runtime, opts, nextAttempt, nextStartTime).catch(
      (error) => {
        opts.onError(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

  socket.on("error", (error: Error) => {
    trackListenerError("listener_websocket_error", error, "listener_socket");
    safeEmitWsEvent("recv", "lifecycle", {
      type: "_ws_error",
      message: error.message,
    });
    if (isDebugEnabled()) {
      console.error("[Listen] WebSocket error:", error);
    }
    // Error triggers close(), which handles retry logic.
  });
}

/**
 * Check if listener is currently active.
 */
export function isListenerActive(): boolean {
  const runtime = getActiveRuntime();
  return runtime !== null && runtime.socket !== null;
}

/**
 * Stop the active listener connection.
 */
export function stopListenerClient(): void {
  const runtime = getActiveRuntime();
  if (!runtime) {
    return;
  }
  setActiveRuntime(null);
  telemetry.setSurface(process.stdin.isTTY ? "tui" : "headless");
  stopRuntime(runtime, true);
}

function asListenerRuntimeForTests(
  runtime: ListenerRuntime | ConversationRuntime,
): ListenerRuntime {
  return "listener" in runtime ? runtime.listener : runtime;
}

function createLegacyTestRuntime(): ConversationRuntime & {
  activeAgentId: string | null;
  activeConversationId: string;
  socket: WebSocket | null;
  workingDirectoryByConversation: Map<string, string>;
  permissionModeByConversation: ListenerRuntime["permissionModeByConversation"];
  reminderStateByConversation: ListenerRuntime["reminderStateByConversation"];
  contextTrackerByConversation: ListenerRuntime["contextTrackerByConversation"];
  systemPromptRecompileByConversation: ListenerRuntime["systemPromptRecompileByConversation"];
  queuedSystemPromptRecompileByConversation: ListenerRuntime["queuedSystemPromptRecompileByConversation"];
  bootWorkingDirectory: string;
  connectionId: string | null;
  connectionName: string | null;
  sessionId: string;
  eventSeqCounter: number;
  queueEmitScheduled: boolean;
  pendingQueueEmitScope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  };
  onWsEvent?: StartListenerOptions["onWsEvent"];
  reminderState: ListenerRuntime["reminderState"];
  reconnectTimeout: NodeJS.Timeout | null;
  heartbeatInterval: NodeJS.Timeout | null;
  intentionallyClosed: boolean;
  hasSuccessfulConnection: boolean;
  everConnected: boolean;
  conversationRuntimes: ListenerRuntime["conversationRuntimes"];
  approvalRuntimeKeyByRequestId: ListenerRuntime["approvalRuntimeKeyByRequestId"];
  memfsSyncedAgents: ListenerRuntime["memfsSyncedAgents"];
  lastEmittedStatus: ListenerRuntime["lastEmittedStatus"];
} {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, null, "default");
  const bridge = runtime as ConversationRuntime & {
    activeAgentId: string | null;
    activeConversationId: string;
    socket: WebSocket | null;
    workingDirectoryByConversation: Map<string, string>;
    permissionModeByConversation: ListenerRuntime["permissionModeByConversation"];
    reminderStateByConversation: ListenerRuntime["reminderStateByConversation"];
    contextTrackerByConversation: ListenerRuntime["contextTrackerByConversation"];
    systemPromptRecompileByConversation: ListenerRuntime["systemPromptRecompileByConversation"];
    queuedSystemPromptRecompileByConversation: ListenerRuntime["queuedSystemPromptRecompileByConversation"];
    bootWorkingDirectory: string;
    connectionId: string | null;
    connectionName: string | null;
    sessionId: string;
    eventSeqCounter: number;
    queueEmitScheduled: boolean;
    pendingQueueEmitScope?: {
      agent_id?: string | null;
      conversation_id?: string | null;
    };
    onWsEvent?: StartListenerOptions["onWsEvent"];
    reminderState: ListenerRuntime["reminderState"];
    reconnectTimeout: NodeJS.Timeout | null;
    heartbeatInterval: NodeJS.Timeout | null;
    intentionallyClosed: boolean;
    hasSuccessfulConnection: boolean;
    everConnected: boolean;
    conversationRuntimes: ListenerRuntime["conversationRuntimes"];
    approvalRuntimeKeyByRequestId: ListenerRuntime["approvalRuntimeKeyByRequestId"];
    memfsSyncedAgents: ListenerRuntime["memfsSyncedAgents"];
    lastEmittedStatus: ListenerRuntime["lastEmittedStatus"];
  };
  for (const [prop, getSet] of Object.entries({
    socket: {
      get: () => listener.socket,
      set: (value: WebSocket | null) => {
        listener.socket = value;
      },
    },
    workingDirectoryByConversation: {
      get: () => listener.workingDirectoryByConversation,
      set: (value: Map<string, string>) => {
        listener.workingDirectoryByConversation = value;
      },
    },
    permissionModeByConversation: {
      get: () => listener.permissionModeByConversation,
      set: (value: ListenerRuntime["permissionModeByConversation"]) => {
        listener.permissionModeByConversation = value;
      },
    },
    reminderStateByConversation: {
      get: () => listener.reminderStateByConversation,
      set: (value: ListenerRuntime["reminderStateByConversation"]) => {
        listener.reminderStateByConversation = value;
      },
    },
    contextTrackerByConversation: {
      get: () => listener.contextTrackerByConversation,
      set: (value: ListenerRuntime["contextTrackerByConversation"]) => {
        listener.contextTrackerByConversation = value;
      },
    },
    systemPromptRecompileByConversation: {
      get: () => listener.systemPromptRecompileByConversation,
      set: (value: ListenerRuntime["systemPromptRecompileByConversation"]) => {
        listener.systemPromptRecompileByConversation = value;
      },
    },
    queuedSystemPromptRecompileByConversation: {
      get: () => listener.queuedSystemPromptRecompileByConversation,
      set: (
        value: ListenerRuntime["queuedSystemPromptRecompileByConversation"],
      ) => {
        listener.queuedSystemPromptRecompileByConversation = value;
      },
    },
    bootWorkingDirectory: {
      get: () => listener.bootWorkingDirectory,
      set: (value: string) => {
        listener.bootWorkingDirectory = value;
      },
    },
    connectionId: {
      get: () => listener.connectionId,
      set: (value: string | null) => {
        listener.connectionId = value;
      },
    },
    connectionName: {
      get: () => listener.connectionName,
      set: (value: string | null) => {
        listener.connectionName = value;
      },
    },
    sessionId: {
      get: () => listener.sessionId,
      set: (value: string) => {
        listener.sessionId = value;
      },
    },
    eventSeqCounter: {
      get: () => listener.eventSeqCounter,
      set: (value: number) => {
        listener.eventSeqCounter = value;
      },
    },
    queueEmitScheduled: {
      get: () => listener.queueEmitScheduled,
      set: (value: boolean) => {
        listener.queueEmitScheduled = value;
      },
    },
    pendingQueueEmitScope: {
      get: () => listener.pendingQueueEmitScope,
      set: (
        value:
          | {
              agent_id?: string | null;
              conversation_id?: string | null;
            }
          | undefined,
      ) => {
        listener.pendingQueueEmitScope = value;
      },
    },
    onWsEvent: {
      get: () => listener.onWsEvent,
      set: (value: StartListenerOptions["onWsEvent"] | undefined) => {
        listener.onWsEvent = value;
      },
    },
    reminderState: {
      get: () => listener.reminderState,
      set: (value: ListenerRuntime["reminderState"]) => {
        listener.reminderState = value;
      },
    },
    reconnectTimeout: {
      get: () => listener.reconnectTimeout,
      set: (value: NodeJS.Timeout | null) => {
        listener.reconnectTimeout = value;
      },
    },
    heartbeatInterval: {
      get: () => listener.heartbeatInterval,
      set: (value: NodeJS.Timeout | null) => {
        listener.heartbeatInterval = value;
      },
    },
    intentionallyClosed: {
      get: () => listener.intentionallyClosed,
      set: (value: boolean) => {
        listener.intentionallyClosed = value;
      },
    },
    hasSuccessfulConnection: {
      get: () => listener.hasSuccessfulConnection,
      set: (value: boolean) => {
        listener.hasSuccessfulConnection = value;
      },
    },
    everConnected: {
      get: () => listener.everConnected,
      set: (value: boolean) => {
        listener.everConnected = value;
      },
    },
    conversationRuntimes: {
      get: () => listener.conversationRuntimes,
      set: (value: ListenerRuntime["conversationRuntimes"]) => {
        listener.conversationRuntimes = value;
      },
    },
    approvalRuntimeKeyByRequestId: {
      get: () => listener.approvalRuntimeKeyByRequestId,
      set: (value: ListenerRuntime["approvalRuntimeKeyByRequestId"]) => {
        listener.approvalRuntimeKeyByRequestId = value;
      },
    },
    memfsSyncedAgents: {
      get: () => listener.memfsSyncedAgents,
      set: (value: ListenerRuntime["memfsSyncedAgents"]) => {
        listener.memfsSyncedAgents = value;
      },
    },
    lastEmittedStatus: {
      get: () => listener.lastEmittedStatus,
      set: (value: ListenerRuntime["lastEmittedStatus"]) => {
        listener.lastEmittedStatus = value;
      },
    },
    activeAgentId: {
      get: () => runtime.agentId,
      set: (value: string | null) => {
        runtime.agentId = value;
      },
    },
    activeConversationId: {
      get: () => runtime.conversationId,
      set: (value: string) => {
        runtime.conversationId = value;
      },
    },
  })) {
    Object.defineProperty(bridge, prop, {
      configurable: true,
      enumerable: false,
      get: getSet.get,
      set: getSet.set,
    });
  }
  return bridge;
}

export {
  rejectPendingApprovalResolvers,
  requestApprovalOverWS,
  resolvePendingApprovalResolver,
} from "./approval";
export { parseServerMessage } from "./protocol-inbound";
export { emitInterruptedStatusDelta } from "./protocol-outbound";

export const __listenClientTestUtils = {
  setChannelsServiceLoaderForTests: (
    loader: null | (() => Promise<ChannelsServiceModule>),
  ) => {
    channelsServiceLoaderOverride = loader;
  },
  createRuntime: createLegacyTestRuntime,
  createListenerRuntime: createRuntime,
  handleModeChange,
  getOrCreateScopedRuntime,
  buildListModelsEntries,
  buildListModelsResponse,
  buildModelUpdateStatusMessage,
  resolveModelForUpdate,
  applyModelUpdateForRuntime,
  stopRuntime: (
    runtime: ListenerRuntime | ConversationRuntime,
    suppressCallbacks: boolean,
  ) => stopRuntime(asListenerRuntimeForTests(runtime), suppressCallbacks),
  setActiveRuntime,
  getListenerStatus,
  getOrCreateConversationRuntime,
  resolveRuntimeScope,
  buildDeviceStatus,
  buildLoopStatus,
  buildQueueSnapshot,
  emitDeviceStatusUpdate,
  emitLoopStatusUpdate,
  handleCwdChange,
  getConversationWorkingDirectory,
  rememberPendingApprovalBatchIds,
  resolvePendingApprovalBatchId,
  resolveRecoveryBatchId,
  clearPendingApprovalBatchIds,
  populateInterruptQueue,
  setConversationWorkingDirectory,
  consumeInterruptQueue,
  stashRecoveredApprovalInterrupts,
  extractInterruptToolReturns,
  emitInterruptToolReturnMessage,
  emitInterruptedStatusDelta,
  emitRetryDelta,
  getInterruptApprovalsForEmission,
  normalizeToolReturnWireMessage,
  normalizeExecutionResultsForInterruptParity,
  shouldAttemptPostStopApprovalRecovery,
  getApprovalContinuationRecoveryDisposition,
  markAwaitingAcceptedApprovalContinuationRunId,
  resolveStaleApprovals,
  normalizeMessageContentImages,
  normalizeInboundMessages,
  consumeQueuedTurn,
  handleIncomingMessage,
  handleApprovalResponseInput,
  handleAbortMessageInput,
  handleChangeDeviceStateInput,
  handleCronCommand,
  isDetachedChannelsCommand,
  handleChannelsProtocolCommand,
  handleSkillCommand,
  handleCreateAgentCommand,
  handleReflectionSettingsCommand,
  enqueueChannelTurn,
  scheduleQueuePump,
  replaySyncStateForRuntime,
  recoverApprovalStateForSync,
  clearRecoveredApprovalStateForScope: (
    runtime: ListenerRuntime | ConversationRuntime,
    scope?: {
      agent_id?: string | null;
      conversation_id?: string | null;
    },
  ) =>
    clearRecoveredApprovalStateForScope(
      asListenerRuntimeForTests(runtime),
      scope,
    ),
  emitStateSync,
};
