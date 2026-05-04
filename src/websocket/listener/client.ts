/**
 * WebSocket client for listen mode
 * Connects to Letta Cloud and receives messages to execute locally
 */

import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import WebSocket from "ws";
import { getBackend } from "../../backend";
import { getChannelRegistry } from "../../channels/registry";
import type { ChannelTurnSource } from "../../channels/types";
import {
  ensureFileIndex,
  getIndexRoot,
  refreshFileIndex,
  searchFileIndex,
  setIndexRoot,
} from "../../cli/helpers/fileIndex";
import { setMessageQueueAdder } from "../../cli/helpers/messageQueueBridge";
import { generatePlanFilePath } from "../../cli/helpers/planName";
import {
  getSubagents,
  subscribe as subscribeToSubagentState,
  subscribeToStreamEvents as subscribeToSubagentStreamEvents,
} from "../../cli/helpers/subagentState";
import {
  estimateSystemPromptTokensFromMemoryDir,
  setSystemPromptDoctorState,
} from "../../cli/helpers/systemPromptWarning";
import { INTERRUPTED_BY_USER } from "../../constants";
import {
  startScheduler as startCronScheduler,
  stopScheduler as stopCronScheduler,
} from "../../cron/scheduler";
import { type DequeuedBatch, QueueRuntime } from "../../queue/queueRuntime";
import { createSharedReminderState } from "../../reminders/state";
import { getCurrentWorkingDirectory } from "../../runtime-context";
import { settingsManager } from "../../settings-manager";
import { telemetry } from "../../telemetry";
import { trackBoundaryError } from "../../telemetry/errorReporting";
import { loadTools } from "../../tools/manager";
import type {
  AbortMessageCommand,
  ApprovalResponseBody,
  ChangeDeviceStateCommand,
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
  handleChannelRegistryEvent,
  handleChannelsProtocolCommand,
  isDetachedChannelsCommand,
  setChannelsServiceLoaderOverride,
} from "./commands/channels";
import { handleCronCommand, handleCronProtocolCommand } from "./commands/cron";
import { handleGitBranchCommand } from "./commands/git-branches";
import {
  handleListMemoryCommand,
  handleMemoryProtocolCommand,
} from "./commands/memory";
import {
  applyModelUpdateForRuntime,
  buildListModelsEntries,
  buildListModelsResponse,
  buildModelUpdateStatusMessage,
  handleModelToolsetCommand,
  resolveModelForUpdate,
} from "./commands/model-toolset";
import { handleSecretsCommand } from "./commands/secrets";
import {
  handleExperimentCommand,
  handleReflectionSettingsCommand,
  handleSettingsProtocolCommand,
} from "./commands/settings";
import {
  handleCreateAgentCommand,
  handleSkillAgentProtocolCommand,
  handleSkillCommand,
} from "./commands/skills-agents";
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
import { runGrepInFiles } from "./grepInFiles";
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
  isEditFileCommand,
  isExecuteCommandCommand,
  isFileOpsCommand,
  isGetTreeCommand,
  isGrepInFilesCommand,
  isListInDirectoryCommand,
  isReadFileCommand,
  isSearchFilesCommand,
  isUnwatchFileCommand,
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
  shouldProcessInboundMessageDirectly,
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
import {
  getListenerTransportKind,
  isListenerTransportOpen,
  type ListenerTransport,
  LocalListenerTransport,
} from "./transport";
import { handleIncomingMessage } from "./turn";
import type {
  ChangeCwdMessage,
  ConversationRuntime,
  IncomingMessage,
  ListenerRuntime,
  ModeChangePayload,
  StartListenerOptions,
} from "./types";
import {
  clearListenerWarmState,
  scheduleListenerWarmupsAfterSync,
} from "./warmup";
import {
  restartWorktreeWatcher,
  stopAllWorktreeWatchers,
} from "./worktree-watcher";

/**
 * Detect whether a directory is a git worktree root.
 * Worktrees have a `.git` **file** (not directory) that points to the main
 * repo's `.git/worktrees/<name>`.  This distinguishes them from normal repos
 * where `.git` is a directory.
 */
async function isGitWorktreeRoot(dir: string): Promise<boolean> {
  try {
    const stats = await lstat(path.join(dir, ".git"));
    return stats.isFile();
  } catch {
    return false;
  }
}

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

function safeTransportSend(
  transport: ListenerTransport,
  payload: unknown,
  errorType: string,
  context: string,
): boolean {
  if (!isListenerTransportOpen(transport)) {
    return false;
  }

  try {
    const serialized =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    transport.send(serialized);
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
    recoverApprovals?: boolean;
    recoverApprovalStateForSync?: (
      runtime: ConversationRuntime,
      scope: { agent_id: string; conversation_id: string },
    ) => Promise<void>;
    scheduleWarmupsAfterSync?: (
      runtime: ListenerRuntime,
      scope: { agent_id: string; conversation_id: string },
    ) => void;
  },
): Promise<void> {
  const syncScopedRuntime = getOrCreateScopedRuntime(
    listenerRuntime,
    scope.agent_id,
    scope.conversation_id,
  );
  const recoverFn =
    opts?.recoverApprovalStateForSync ?? recoverApprovalStateForSync;

  if (opts?.recoverApprovals ?? true) {
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
  }

  emitStateSync(socket, listenerRuntime, scope);
  (opts?.scheduleWarmupsAfterSync ?? scheduleListenerWarmupsAfterSync)(
    listenerRuntime,
    scope,
  );
}

async function recoverPendingChannelControlRequests(
  listener: ListenerRuntime,
  opts?: {
    recoverApprovalStateForSync?: (
      runtime: ConversationRuntime,
      scope: { agent_id: string; conversation_id: string },
    ) => Promise<void>;
  },
): Promise<void> {
  const registry = getChannelRegistry();
  if (!registry) {
    return;
  }

  const pendingEntries = registry.getPendingControlRequests();
  if (pendingEntries.length === 0) {
    return;
  }

  const recoverFn =
    opts?.recoverApprovalStateForSync ?? recoverApprovalStateForSync;
  const entriesByScope = new Map<
    string,
    {
      scope: { agent_id: string; conversation_id: string };
      entries: typeof pendingEntries;
    }
  >();

  for (const entry of pendingEntries) {
    const scope = {
      agent_id: entry.event.source.agentId,
      conversation_id: entry.event.source.conversationId,
    };
    const scopeKey = `${scope.agent_id}:${scope.conversation_id}`;
    const existing = entriesByScope.get(scopeKey);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    entriesByScope.set(scopeKey, {
      scope,
      entries: [entry],
    });
  }

  for (const { scope, entries } of entriesByScope.values()) {
    const runtime = getOrCreateScopedRuntime(
      listener,
      scope.agent_id,
      scope.conversation_id,
    );
    const livePendingRequestIds = new Set(
      runtime.pendingApprovalResolvers.keys(),
    );
    const shouldRecoverFromBackend = entries.some(
      (entry) => !livePendingRequestIds.has(entry.event.requestId),
    );

    if (shouldRecoverFromBackend) {
      try {
        await recoverFn(runtime, scope);
      } catch (error) {
        trackListenerError(
          "listener_channel_control_request_recovery_failed",
          error,
          "listener_channel_control_request_recovery",
        );
        if (isDebugEnabled()) {
          console.warn(
            "[Listen] Channel control request recovery failed:",
            error,
          );
        }
        continue;
      }
    }

    const recoveredPendingRequestIds =
      getRecoveredApprovalStateForScope(listener, scope)?.pendingRequestIds ??
      new Set<string>();

    for (const entry of entries) {
      const requestId = entry.event.requestId;
      const stillPending =
        livePendingRequestIds.has(requestId) ||
        recoveredPendingRequestIds.has(requestId);

      if (!stillPending) {
        registry.clearPendingControlRequest(requestId);
        continue;
      }

      if (entry.deliveredThisProcess) {
        continue;
      }

      await registry.redeliverPendingControlRequest(requestId);
    }
  }
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
async function wireChannelIngress(
  listener: ListenerRuntime,
  socket: ListenerTransport,
  opts: StartListenerOptions,
  processQueuedTurn: ProcessQueuedTurn,
): Promise<void> {
  const registry = getChannelRegistry();
  if (!registry) return;

  registry.setMessageHandler((delivery) => {
    // Follow the same pattern as cron/scheduler.ts:131-157
    const rawRuntime = getOrCreateConversationRuntime(
      listener,
      delivery.route.agentId,
      delivery.route.conversationId,
    );
    if (!rawRuntime) return;

    const conversationRuntime = ensureConversationQueueRuntime(
      listener,
      rawRuntime,
    );

    const enqueuedItem = enqueueChannelTurn(
      conversationRuntime,
      delivery.route,
      delivery.content,
      delivery.turnSources,
    );
    if (!enqueuedItem) {
      return;
    }

    for (const turnSource of delivery.turnSources ?? []) {
      void registry.dispatchTurnLifecycleEvent({
        type: "queued",
        source: turnSource,
      });
    }

    scheduleQueuePump(conversationRuntime, socket, opts, processQueuedTurn);
  });

  registry.setEventHandler((event) => {
    handleChannelRegistryEvent(event, socket, listener, safeSocketSend);
  });

  await recoverPendingChannelControlRequests(listener);

  registry.setApprovalResponseHandler(async ({ runtime, response }) =>
    handleApprovalResponseInput(listener, {
      runtime,
      response,
      socket,
      opts,
      processQueuedTurn,
    }),
  );

  registry.setReady();
}

function stampInboundUserMessageOtids(
  incoming: IncomingMessage,
): IncomingMessage {
  let didChange = false;
  const messages = incoming.messages.map((payload) => {
    if (!("content" in payload) || payload.otid) {
      return payload;
    }

    didChange = true;
    return {
      ...payload,
      otid:
        "client_message_id" in payload &&
        typeof payload.client_message_id === "string"
          ? payload.client_message_id
          : crypto.randomUUID(),
    } satisfies MessageCreate & { client_message_id?: string };
  });

  if (!didChange) {
    return incoming;
  }

  return {
    ...incoming,
    messages,
  };
}

function enqueueChannelTurn(
  runtime: ConversationRuntime,
  route: {
    agentId: string;
    conversationId: string;
  },
  messageContent: MessageCreate["content"],
  turnSources?: ChannelTurnSource[],
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

  runtime.queuedMessagesByItemId.set(
    enqueuedItem.id,
    stampInboundUserMessageOtids({
      type: "message",
      agentId: route.agentId,
      conversationId: route.conversationId,
      ...(turnSources?.length ? { channelTurnSources: turnSources } : {}),
      messages: [
        {
          role: "user",
          content: messageContent,
          client_message_id: clientMessageId,
        } satisfies MessageCreate & { client_message_id?: string },
      ],
    }),
  );

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
    socket: ListenerTransport;
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
      socket: ListenerTransport,
      response: ApprovalResponseBody,
      processTurn: typeof handleIncomingMessage,
      opts?: {
        onStatusChange?: StartListenerOptions["onStatusChange"];
        connectionId?: string;
      },
    ) => Promise<boolean>;
    scheduleQueuePump: (
      runtime: ConversationRuntime,
      socket: ListenerTransport,
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
      const cancelId =
        conversationId === "default" || !conversationId
          ? agentId
          : conversationId;
      await getBackend().cancelConversation(cancelId);
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

    // If the new cwd is outside the current file-index root, or is a git
    // worktree nested under it, re-root the index so file search covers
    // the new workspace.  setIndexRoot() triggers a non-blocking rebuild
    // and does NOT mutate process.cwd(), keeping concurrent conversations safe.
    const currentRoot = getIndexRoot();
    const needsReroot =
      !normalizedPath.startsWith(currentRoot) ||
      (normalizedPath !== currentRoot &&
        (await isGitWorktreeRoot(normalizedPath)));
    if (needsReroot) {
      setIndexRoot(normalizedPath);
    }

    // Proactively warm the file index so @ file search is instant when
    // the user first types "@".  ensureFileIndex() is idempotent — if the
    // index was already built (or a rebuild is in-flight from setIndexRoot
    // above), this returns immediately / joins the existing promise.
    void ensureFileIndex();

    emitDeviceStatusUpdate(socket, runtime, {
      agent_id: agentId,
      conversation_id: conversationId,
    });

    // Restart the worktree file watcher for the new CWD so we detect
    // any future worktree creation under the updated directory.
    restartWorktreeWatcher({
      runtime: runtime.listener,
      agentId,
      conversationId,
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
  const bootWorkingDirectory = getCurrentWorkingDirectory();
  return {
    socket: null,
    transport: null,
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
    worktreeWatcherByConversation: new Map(),
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
    secretsHydrationByAgent: new Map(),
    secretsHydrationFreshnessByAgent: new Map(),
    secretsDirtyAgents: new Set(),
    agentMetadataByAgent: new Map(),
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
  clearListenerWarmState(runtime);
  runtime.reminderStateByConversation.clear();
  runtime.contextTrackerByConversation.clear();
  runtime.systemPromptRecompileByConversation.clear();
  runtime.queuedSystemPromptRecompileByConversation.clear();
  stopAllWorktreeWatchers(runtime);

  if (!runtime.socket) {
    runtime.transport = null;
    return;
  }

  const socket = runtime.socket;
  runtime.socket = null;
  runtime.transport = null;

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

async function startConnectedListenerRuntime(
  runtime: ListenerRuntime,
  transport: ListenerTransport,
  opts: Pick<
    StartListenerOptions,
    "connectionId" | "onConnected" | "onStatusChange" | "onWsEvent"
  >,
  processQueuedTurn: ProcessQueuedTurn,
  options: {
    startHeartbeat?: boolean;
    startCronScheduler?: boolean;
  } = {},
): Promise<void> {
  if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
    return;
  }

  const shouldStartHeartbeat = options.startHeartbeat !== false;
  // LETTA_DISABLE_CRON_SCHEDULER=1 lets users opt out entirely. Useful when
  // running multiple letta-code instances against the same agent dir, since
  // only one process can hold the lease and the others would otherwise log
  // "scheduler lease held by PID …" on every connect.
  const cronSchedulerDisabledByEnv =
    process.env.LETTA_DISABLE_CRON_SCHEDULER === "1";
  const shouldStartCronScheduler =
    options.startCronScheduler !== false && !cronSchedulerDisabledByEnv;

  runtime.transport = transport;
  safeEmitWsEvent("recv", "lifecycle", {
    type:
      getListenerTransportKind(transport) === "websocket"
        ? "_ws_open"
        : "_local_open",
  });
  runtime.hasSuccessfulConnection = true;
  runtime.everConnected = true;
  opts.onConnected(opts.connectionId);

  if (runtime.conversationRuntimes.size === 0) {
    // Don't emit device_status before the lookup store exists.
    // Without a conversation runtime, the scope resolves to
    // agent:__unknown__ which misses persisted CWD and permission
    // mode entries. The web's sync command will create a scoped
    // runtime and emit a properly-scoped device_status at that point.
    emitLoopStatusUpdate(transport, runtime);
  } else {
    // Preserve existing per-conversation reminder and context state across
    // pure transport reconnects; only refresh the live status snapshots here.
    for (const conversationRuntime of runtime.conversationRuntimes.values()) {
      const scope = {
        agent_id: conversationRuntime.agentId,
        conversation_id: conversationRuntime.conversationId,
      };
      emitDeviceStatusUpdate(transport, conversationRuntime, scope);
      emitLoopStatusUpdate(transport, conversationRuntime, scope);
    }
  }

  // Subscribe to subagent state changes and emit snapshots over the listener
  // transport. Local channel mode intentionally discards these frames.
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
  runtime._unsubscribeSubagentStreamEvents?.();
  runtime._unsubscribeSubagentStreamEvents = subscribeToSubagentStreamEvents(
    (subagentId, event) => {
      if (!isListenerTransportOpen(transport)) return;

      const subagent = getSubagents().find((entry) => entry.id === subagentId);
      if (subagent?.silent === true) {
        // Reflection/background "silent" subagents should not stream their
        // internal transcript into the parent conversation.
        return;
      }

      // The event has { type: "message", message_type, ...LettaStreamingResponse }
      // plus extra headless fields (session_id, uuid) that pass through harmlessly.
      emitStreamDelta(
        transport,
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
    scheduleQueuePump(
      targetRuntime,
      transport,
      opts as StartListenerOptions,
      processQueuedTurn,
    );
  });

  if (shouldStartHeartbeat) {
    runtime.heartbeatInterval = setInterval(() => {
      safeTransportSend(
        transport,
        { type: "ping" },
        "listener_ping_send_failed",
        "listener_heartbeat",
      );
    }, 30000);
  }

  if (shouldStartCronScheduler) {
    startCronScheduler(
      transport,
      opts as StartListenerOptions,
      processQueuedTurn,
    );
  }

  // Wire channel ingress (if channels are active).
  await wireChannelIngress(
    runtime,
    transport,
    opts as StartListenerOptions,
    processQueuedTurn,
  );
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

export interface StartLocalChannelListenerOptions {
  connectionId: string;
  deviceId: string;
  connectionName: string;
  onConnected: (connectionId: string) => void;
  onError: (error: Error) => void;
  onStatusChange?: StartListenerOptions["onStatusChange"];
  onWsEvent?: StartListenerOptions["onWsEvent"];
}

/**
 * Start a listener runtime for local channel adapters without environment
 * registration or a remote WebSocket server.
 */
export async function startLocalChannelListener(
  opts: StartLocalChannelListenerOptions,
): Promise<void> {
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

  try {
    await loadTools();
    const transport = new LocalListenerTransport();
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
        transport,
        scopedRuntime,
        opts.onStatusChange,
        opts.connectionId,
        dequeuedBatch.batchId,
      );
    };

    await startConnectedListenerRuntime(
      runtime,
      transport,
      opts,
      processQueuedTurn,
      { startHeartbeat: false, startCronScheduler: true },
    );
  } catch (error) {
    stopRuntime(runtime, true);
    if (getActiveRuntime() === runtime) {
      setActiveRuntime(null);
    }
    opts.onError(error instanceof Error ? error : new Error(String(error)));
  }
}

/** File/directory names filtered from directory listings (OS/VCS noise). */
const DIR_LISTING_IGNORED_NAMES = new Set([".DS_Store", ".git", "Thumbs.db"]);

interface DirListing {
  folders: string[];
  files: string[];
}

/**
 * List a single directory by merging the file index (instant) with readdir
 * (to pick up `.lettaignore`'d entries). Shared by `list_in_directory` and
 * `get_tree` handlers.
 *
 * @param absDir      Absolute path to the directory.
 * @param indexRoot   Root of the file index (undefined if unavailable).
 * @param includeFiles  Whether to include files (not just folders).
 */
async function listDirectoryHybrid(
  absDir: string,
  indexRoot: string | undefined,
  includeFiles: boolean,
): Promise<DirListing> {
  // 1. Query file index (instant, from memory)
  let indexedNames: Set<string> | undefined;
  const indexedFolders: string[] = [];
  const indexedFiles: string[] = [];

  if (indexRoot !== undefined) {
    const relPath = path.relative(indexRoot, absDir);
    if (!relPath.startsWith("..")) {
      const indexed = searchFileIndex({
        searchDir: relPath || ".",
        pattern: "",
        deep: false,
        maxResults: 10000,
      });
      indexedNames = new Set<string>();
      for (const entry of indexed) {
        const name = entry.path.split(path.sep).pop() ?? entry.path;
        indexedNames.add(name);
        if (entry.type === "dir") {
          indexedFolders.push(name);
        } else {
          indexedFiles.push(name);
        }
      }
    }
  }

  // 2. readdir to fill gaps (entries not in the index)
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(absDir, { withFileTypes: true });

  const extraFolders: string[] = [];
  const extraFiles: string[] = [];
  for (const e of entries) {
    if (DIR_LISTING_IGNORED_NAMES.has(e.name)) continue;
    if (indexedNames?.has(e.name)) continue;
    if (e.isDirectory()) {
      extraFolders.push(e.name);
    } else if (includeFiles) {
      extraFiles.push(e.name);
    }
  }

  // 3. Merge and sort
  return {
    folders: [...indexedFolders, ...extraFolders].sort((a, b) =>
      a.localeCompare(b),
    ),
    files: includeFiles
      ? [...indexedFiles, ...extraFiles].sort((a, b) => a.localeCompare(b))
      : [],
  };
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
  const transport = socket;
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
      transport,
      scopedRuntime,
      opts.onStatusChange,
      opts.connectionId,
      dequeuedBatch.batchId,
    );
  };

  socket.on("open", async () => {
    await startConnectedListenerRuntime(
      runtime,
      transport,
      opts,
      processQueuedTurn,
      { startHeartbeat: true, startCronScheduler: true },
    );
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
        await replaySyncStateForRuntime(runtime, socket, parsed.runtime, {
          recoverApprovals: parsed.recover_approvals !== false,
        });
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
          clientToolAllowlist: inputPayload.client_tool_allowlist,
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

        const processIncomingMessageDirectly = (
          directIncoming: IncomingMessage,
        ): void => {
          scopedRuntime.messageQueue = scopedRuntime.messageQueue
            .then(async () => {
              if (
                runtime !== getActiveRuntime() ||
                runtime.intentionallyClosed
              ) {
                return;
              }
              emitListenerStatus(
                runtime,
                opts.onStatusChange,
                opts.connectionId,
              );
              await handleIncomingMessage(
                directIncoming,
                socket,
                scopedRuntime,
                opts.onStatusChange,
                opts.connectionId,
              );
              emitListenerStatus(
                runtime,
                opts.onStatusChange,
                opts.connectionId,
              );
              if (
                scopedRuntime.queueRuntime.length > 0 ||
                scopedRuntime.queuePumpScheduled ||
                scopedRuntime.queuePumpActive
              ) {
                scheduleQueuePump(
                  scopedRuntime,
                  socket,
                  opts,
                  processQueuedTurn,
                );
              }
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
              emitListenerStatus(
                runtime,
                opts.onStatusChange,
                opts.connectionId,
              );
              scheduleQueuePump(scopedRuntime, socket, opts, processQueuedTurn);
            });
        };

        if (shouldQueueInboundMessage(incoming)) {
          const stampedIncoming = stampInboundUserMessageOtids(incoming);
          if (
            shouldProcessInboundMessageDirectly(scopedRuntime, stampedIncoming)
          ) {
            processIncomingMessageDirectly(stampedIncoming);
            return;
          }

          const firstUserPayload = stampedIncoming.messages.find(
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
                stampedIncoming,
              );
            }
          }
          scheduleQueuePump(scopedRuntime, socket, opts, processQueuedTurn);
          return;
        }

        processIncomingMessageDirectly(incoming);
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
              const needsReroot =
                (!parsed.cwd.startsWith(currentRoot + path.sep) &&
                  parsed.cwd !== currentRoot) ||
                (parsed.cwd !== currentRoot &&
                  (await isGitWorktreeRoot(parsed.cwd)));
              if (needsReroot) {
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

      // ── Find-in-files content search (no runtime scope required) ──────
      if (isGrepInFilesCommand(parsed)) {
        runDetachedListenerTask("grep_in_files", async () => {
          try {
            // Re-root the index if the requested cwd lives outside it, so
            // "search root" matches what the user expects in the UI.
            if (parsed.cwd) {
              const currentRoot = getIndexRoot();
              if (
                !parsed.cwd.startsWith(currentRoot + path.sep) &&
                parsed.cwd !== currentRoot
              ) {
                setIndexRoot(parsed.cwd);
              }
            }

            const searchRoot = parsed.cwd ?? getIndexRoot();
            const { matches, totalMatches, totalFiles, truncated } =
              await runGrepInFiles({
                searchRoot,
                query: parsed.query,
                isRegex: parsed.is_regex ?? false,
                caseSensitive: parsed.case_sensitive ?? false,
                wholeWord: parsed.whole_word ?? false,
                glob: parsed.glob,
                maxResults: parsed.max_results ?? 500,
                contextLines: parsed.context_lines ?? 2,
              });

            safeSocketSend(
              socket,
              {
                type: "grep_in_files_response",
                request_id: parsed.request_id,
                success: true,
                matches,
                total_matches: totalMatches,
                total_files: totalFiles,
                truncated,
              },
              "listener_grep_in_files_send_failed",
              "listener_grep_in_files",
            );
          } catch (error) {
            trackListenerError(
              "listener_grep_in_files_failed",
              error,
              "listener_grep_in_files",
            );
            safeSocketSend(
              socket,
              {
                type: "grep_in_files_response",
                request_id: parsed.request_id,
                success: false,
                matches: [],
                total_matches: 0,
                total_files: 0,
                truncated: false,
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to search file contents",
              },
              "listener_grep_in_files_send_failed",
              "listener_grep_in_files",
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
            let indexRoot: string | undefined;
            try {
              await ensureFileIndex();
              indexRoot = getIndexRoot();
            } catch {
              // Index not available — readdir only
            }

            console.log(`[Listen] Reading directory: ${parsed.path}`);
            const { folders: allFolders, files: allFiles } =
              await listDirectoryHybrid(
                parsed.path,
                indexRoot,
                !!parsed.include_files,
              );

            const total = allFolders.length + allFiles.length;
            const offset = parsed.offset ?? 0;
            const limit = parsed.limit ?? total;

            // Paginate over the combined [folders, files] list
            const combined = [...allFolders, ...allFiles];
            const page = combined.slice(offset, offset + limit);
            const folderSet = new Set(allFolders);
            const folders = page.filter((name) => folderSet.has(name));
            const files = page.filter((name) => !folderSet.has(name));

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

      // ── Depth-limited subtree fetch (no runtime scope required) ──────
      if (isGetTreeCommand(parsed)) {
        console.log(
          `[Listen] Received get_tree command: path=${parsed.path}, depth=${parsed.depth}`,
        );
        runDetachedListenerTask("get_tree", async () => {
          try {
            // Walk the directory tree up to the requested depth, combining
            // file index results with readdir to include non-indexed entries.
            interface TreeEntry {
              path: string;
              type: "file" | "dir";
            }
            const results: TreeEntry[] = [];
            let hasMoreDepth = false;

            // Warm the file index once before walking the tree.
            let indexRoot: string | undefined;
            try {
              await ensureFileIndex();
              indexRoot = getIndexRoot();
            } catch {
              // Index not available — readdir only for all directories
            }

            // BFS queue: [absolutePath, relativePath, currentDepth]
            // Uses an index pointer for O(1) dequeue instead of shift().
            const queue: [string, string, number][] = [[parsed.path, "", 0]];
            let qi = 0;

            while (qi < queue.length) {
              const item = queue[qi++];
              if (!item) break;
              const [absDir, relDir, depth] = item;

              if (depth >= parsed.depth) {
                if (depth === parsed.depth && relDir !== "") {
                  hasMoreDepth = true;
                }
                continue;
              }

              let listing: DirListing;
              try {
                listing = await listDirectoryHybrid(absDir, indexRoot, true);
              } catch {
                // Can't read directory — skip
                continue;
              }

              // Relative paths always use '/' (converted to OS separator on the frontend)
              for (const name of listing.folders) {
                const entryRel = relDir === "" ? name : `${relDir}/${name}`;
                results.push({ path: entryRel, type: "dir" });
                queue.push([path.join(absDir, name), entryRel, depth + 1]);
              }
              for (const name of listing.files) {
                const entryRel = relDir === "" ? name : `${relDir}/${name}`;
                results.push({ path: entryRel, type: "file" });
              }
            }

            console.log(
              `[Listen] Sending get_tree_response: ${results.length} entries, has_more_depth=${hasMoreDepth}`,
            );
            safeSocketSend(
              socket,
              {
                type: "get_tree_response",
                path: parsed.path,
                request_id: parsed.request_id,
                entries: results,
                has_more_depth: hasMoreDepth,
                success: true,
              },
              "listener_get_tree_send_failed",
              "listener_get_tree",
            );
          } catch (err) {
            trackListenerError(
              "listener_get_tree_failed",
              err,
              "listener_file_browser",
            );
            console.error(
              `[Listen] get_tree error: ${err instanceof Error ? err.message : "Unknown error"}`,
            );
            safeSocketSend(
              socket,
              {
                type: "get_tree_response",
                path: parsed.path,
                request_id: parsed.request_id,
                entries: [],
                has_more_depth: false,
                success: false,
                error:
                  err instanceof Error ? err.message : "Failed to get tree",
              },
              "listener_get_tree_send_failed",
              "listener_get_tree",
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
            // Update the file index so the sidebar Merkle tree stays current
            void refreshFileIndex();
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
            const { readFile } = await import("node:fs/promises");
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
            // Update the file index so the sidebar Merkle tree stays current
            if (result.replacements > 0) {
              void refreshFileIndex();
            }

            // Notify web clients of the new content so they can update live.
            if (result.replacements > 0) {
              try {
                const contentAfter = await readFile(parsed.file_path, "utf-8");
                safeSocketSend(
                  socket,
                  {
                    type: "file_ops",
                    path: parsed.file_path,
                    cg_entries: [],
                    ops: [],
                    source: "agent",
                    document_content: contentAfter,
                  },
                  "listener_edit_file_ops_send_failed",
                  "listener_edit_file",
                );
              } catch {
                // Non-fatal: content broadcast is best-effort.
              }
            }

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

      // ── Egwalker CRDT ops (no runtime scope required) ─────────────────
      if (isFileOpsCommand(parsed)) {
        // Use document_content if provided (reliable, no race conditions).
        // Falls back to applying ops character-by-character.
        if (parsed.document_content !== undefined) {
          runDetachedListenerTask("file_ops", async () => {
            try {
              const { writeFile } = await import("node:fs/promises");
              const content = parsed.document_content as string;
              await writeFile(parsed.path, content, "utf-8");
              console.log(
                `[Listen] file_ops: wrote ${content.length} bytes to ${parsed.path}`,
              );
            } catch (err) {
              console.error(
                `[Listen] file_ops error: ${err instanceof Error ? err.message : "Unknown error"}`,
              );
            }
          });
        }
        return;
      }

      if (
        handleMemoryProtocolCommand(parsed, {
          socket,
          safeSocketSend,
          runDetachedListenerTask,
        })
      ) {
        return;
      }

      if (
        handleModelToolsetCommand(parsed, {
          socket,
          runtime,
          safeSocketSend,
          runDetachedListenerTask,
          getOrCreateScopedRuntime,
        })
      ) {
        return;
      }

      if (
        handleCronProtocolCommand(parsed, {
          socket,
          safeSocketSend,
          runDetachedListenerTask,
        })
      ) {
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
            runDetachedListenerTask,
            wireChannelIngress,
            safeSocketSend,
          );
        });
        return;
      }

      if (
        handleSkillAgentProtocolCommand(parsed, {
          socket,
          safeSocketSend,
          runDetachedListenerTask,
        })
      ) {
        return;
      }

      if (
        handleSettingsProtocolCommand(parsed, {
          socket,
          runtime,
          safeSocketSend,
          runDetachedListenerTask,
        })
      ) {
        return;
      }

      // ── Slash commands (execute_command) ────────────────────────────────
      if (isExecuteCommandCommand(parsed)) {
        // Internal-only: refresh doctor state after recompile (no chat output)
        if (parsed.command_id === "refresh_doctor_state") {
          const agentId = parsed.runtime.agent_id;
          if (agentId && settingsManager.isMemfsEnabled(agentId)) {
            try {
              const { getMemoryFilesystemRoot } = await import(
                "../../agent/memoryFilesystem"
              );
              const memoryDir = getMemoryFilesystemRoot(agentId);
              const tokens = estimateSystemPromptTokensFromMemoryDir(memoryDir);
              setSystemPromptDoctorState(agentId, tokens);
            } catch {
              // best-effort
            }
          }
          emitDeviceStatusUpdate(socket, runtime, parsed.runtime);
          return;
        }

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

      if (
        handleGitBranchCommand(parsed, {
          socket,
          runtime,
          safeSocketSend,
          runDetachedListenerTask,
        })
      ) {
        return;
      }

      if (
        handleSecretsCommand(parsed, {
          socket,
          runtime,
          safeSocketSend,
          runDetachedListenerTask,
        })
      ) {
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
    clearListenerWarmState(runtime);
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
  return runtime !== null && runtime.transport !== null;
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
  secretsHydrationByAgent: ListenerRuntime["secretsHydrationByAgent"];
  secretsHydrationFreshnessByAgent: ListenerRuntime["secretsHydrationFreshnessByAgent"];
  secretsDirtyAgents: ListenerRuntime["secretsDirtyAgents"];
  agentMetadataByAgent: ListenerRuntime["agentMetadataByAgent"];
  worktreeWatcherByConversation: ListenerRuntime["worktreeWatcherByConversation"];
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
    secretsHydrationByAgent: ListenerRuntime["secretsHydrationByAgent"];
    secretsHydrationFreshnessByAgent: ListenerRuntime["secretsHydrationFreshnessByAgent"];
    secretsDirtyAgents: ListenerRuntime["secretsDirtyAgents"];
    agentMetadataByAgent: ListenerRuntime["agentMetadataByAgent"];
    worktreeWatcherByConversation: ListenerRuntime["worktreeWatcherByConversation"];
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
    secretsHydrationByAgent: {
      get: () => listener.secretsHydrationByAgent,
      set: (value: ListenerRuntime["secretsHydrationByAgent"]) => {
        listener.secretsHydrationByAgent = value;
      },
    },
    secretsHydrationFreshnessByAgent: {
      get: () => listener.secretsHydrationFreshnessByAgent,
      set: (value: ListenerRuntime["secretsHydrationFreshnessByAgent"]) => {
        listener.secretsHydrationFreshnessByAgent = value;
      },
    },
    secretsDirtyAgents: {
      get: () => listener.secretsDirtyAgents,
      set: (value: ListenerRuntime["secretsDirtyAgents"]) => {
        listener.secretsDirtyAgents = value;
      },
    },
    agentMetadataByAgent: {
      get: () => listener.agentMetadataByAgent,
      set: (value: ListenerRuntime["agentMetadataByAgent"]) => {
        listener.agentMetadataByAgent = value;
      },
    },
    worktreeWatcherByConversation: {
      get: () => listener.worktreeWatcherByConversation,
      set: (value: ListenerRuntime["worktreeWatcherByConversation"]) => {
        listener.worktreeWatcherByConversation = value;
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
    loader: Parameters<typeof setChannelsServiceLoaderOverride>[0],
  ) => {
    setChannelsServiceLoaderOverride(loader);
  },
  createRuntime: createLegacyTestRuntime,
  createListenerRuntime: createRuntime,
  startConnectedListenerRuntime: startConnectedListenerRuntime,
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
  handleCronCommand: (
    parsed: Parameters<typeof handleCronCommand>[0],
    socket: WebSocket,
  ) => handleCronCommand(parsed, socket, safeSocketSend),
  handleListMemoryCommand: (
    parsed: Parameters<typeof handleListMemoryCommand>[0],
    socket: WebSocket,
    overrides?: Parameters<typeof handleListMemoryCommand>[3],
  ) => handleListMemoryCommand(parsed, socket, safeSocketSend, overrides),
  isDetachedChannelsCommand,
  handleChannelsProtocolCommand: (
    parsed: Parameters<typeof handleChannelsProtocolCommand>[0],
    socket: WebSocket,
    runtime: ListenerRuntime,
    opts: Parameters<typeof handleChannelsProtocolCommand>[3],
    processQueuedTurn: Parameters<typeof handleChannelsProtocolCommand>[4],
  ) =>
    handleChannelsProtocolCommand(
      parsed,
      socket,
      runtime,
      opts,
      processQueuedTurn,
      runDetachedListenerTask,
      wireChannelIngress,
      safeSocketSend,
    ),
  handleChannelRegistryEvent: (
    event: Parameters<typeof handleChannelRegistryEvent>[0],
    socket: Parameters<typeof handleChannelRegistryEvent>[1],
    runtime: ListenerRuntime,
  ) => handleChannelRegistryEvent(event, socket, runtime, safeSocketSend),
  handleSkillCommand: (
    parsed: Parameters<typeof handleSkillCommand>[0],
    socket: WebSocket,
  ) => handleSkillCommand(parsed, socket, safeSocketSend),
  handleCreateAgentCommand: (
    parsed: Parameters<typeof handleCreateAgentCommand>[0],
    socket: WebSocket,
  ) => handleCreateAgentCommand(parsed, socket, safeSocketSend),
  handleExperimentCommand: (
    parsed: Parameters<typeof handleExperimentCommand>[0],
    socket: WebSocket,
    listener: ListenerRuntime,
  ) => handleExperimentCommand(parsed, socket, listener, safeSocketSend),
  handleReflectionSettingsCommand: (
    parsed: Parameters<typeof handleReflectionSettingsCommand>[0],
    socket: WebSocket,
    listener: ListenerRuntime,
  ) =>
    handleReflectionSettingsCommand(parsed, socket, listener, safeSocketSend),
  enqueueChannelTurn,
  scheduleQueuePump,
  replaySyncStateForRuntime: (
    runtime: ListenerRuntime,
    socket: WebSocket,
    scope: { agent_id: string; conversation_id: string },
    opts?: {
      recoverApprovals?: boolean;
      recoverApprovalStateForSync?: (
        runtime: ConversationRuntime,
        scope: { agent_id: string; conversation_id: string },
      ) => Promise<void>;
      scheduleWarmupsAfterSync?: (
        runtime: ListenerRuntime,
        scope: { agent_id: string; conversation_id: string },
      ) => void;
    },
  ) =>
    replaySyncStateForRuntime(runtime, socket, scope, {
      ...opts,
      scheduleWarmupsAfterSync: opts?.scheduleWarmupsAfterSync ?? (() => {}),
    }),
  recoverPendingChannelControlRequests,
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
